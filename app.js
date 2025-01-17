'use strict'

const { sentry, init } = require('./lib/sentry-io') // { sentry, init, startTransaction }

const Homey = require('homey')

const hasData = require('./lib/has-data')
const getDateTimeFormat = require('./lib/get-datetime-format')
const getContent = require('./lib/get-ical-content')
const getActiveEvents = require('./lib/get-active-events')
const filterUpdatedCalendars = require('./lib/filter-updated-calendars')
const getEventUids = require('./lib/get-event-uids')
const getNewEvents = require('./lib/get-new-events')
const sortCalendarsEvents = require('./lib/sort-calendars')

const triggersHandler = require('./handlers/triggers')
const conditionsHandler = require('./handlers/conditions')
const actionsHandler = require('./handlers/actions')

class IcalCalendar extends Homey.App {
  onInit () {
    this.log(`${Homey.manifest.name.en} v${Homey.manifest.version} is running...`)

    // set a variable to control if getEvents is already running
    this.isGettingEvents = false

    // initialize sentry.io
    init(Homey)
    this.sentry = sentry

    // register variableMgmt to this app class
    this.variableMgmt = require('./lib/variable-management')

    // get date and time format as an object
    this.variableMgmt.dateTimeFormat = getDateTimeFormat(this)

    // instantiate triggers
    triggersHandler(this)

    // instantiate conditions
    conditionsHandler(this)

    // instantiate actions
    actionsHandler(this)

    // get ical events
    this.log('onInit: Triggering getEvents with reregistering of tokens')
    this.getEvents(true)

    // register callback when settings has been set
    Homey.ManagerSettings.on('set', args => {
      if (!args) return

      const { icalUris, eventLimit, nextEventTokensPerCalendar, dateFormat, timeFormat } = this.variableMgmt.setting
      if ([icalUris, eventLimit, nextEventTokensPerCalendar].includes(args)) {
        // sync calendars when calendar specific settings have been changed
        setTimeout(() => {
          if (!this.isGettingEvents) {
            this.log(`onInit/${args}: Triggering getEvents with reregistering of tokens`)
            this.getEvents(true)
          }
        }, 500)
      } else if ([dateFormat, timeFormat].includes(args)) {
        // get new date/time format
        this.variableMgmt.dateTimeFormat = getDateTimeFormat(this)
      }
    })

    // remove cron tasks on unload
    Homey.on('unload', () => this.unregisterCronTasks())

    // register cron tasks for updateCalendar and triggerEvents
    this.registerCronTasks()
  }

  async getEvents (reregisterCalendarTokens = false) {
    this.isGettingEvents = true

    // get URI from settings
    const calendars = Homey.ManagerSettings.get(this.variableMgmt.setting.icalUris)
    // get event limit from settings or use the default
    const eventLimit = Homey.ManagerSettings.get(this.variableMgmt.setting.eventLimit) || this.variableMgmt.setting.eventLimitDefault
    const oldCalendarsUidsStorage = Homey.ManagerSettings.get(this.variableMgmt.storage.eventUids)
    const oldCalendarsUids = hasData(oldCalendarsUidsStorage) ? JSON.parse(oldCalendarsUidsStorage) : []
    this.log('getEvents: oldCalendarsUids --', oldCalendarsUids.length)
    const calendarsEvents = []

    // get ical events
    if (calendars) {
      this.log('getEvents: Getting calendars:', calendars.length)

      for (let i = 0; i < calendars.length; i++) {
        let { name, uri } = calendars[i]
        if (uri === '') {
          this.log(`getEvents: Calendar '${name}' has empty uri. Skipping...`)
          continue
        } else if (!uri.includes('http://') && !uri.includes('https://') && !uri.includes('webcal://')) {
          this.log(`getEvents: Uri for calendar '${name}' is invalid. Skipping...`)
          calendars[i] = { name, uri, failed: `Uri for calendar '${name}' is invalid` }
          Homey.ManagerSettings.set(this.variableMgmt.setting.icalUris, calendars)
          this.log(`getEvents: 'failed' setting value added to calendar '${name}'`)
          continue
        }

        if (uri.indexOf('webcal://') === 0) {
          uri = uri.replace('webcal://', 'https://')
          this.log(`getEvents: Calendar '${name}': webcal found and replaced with https://`)
        }

        this.log(`getEvents: Getting events (${eventLimit.value} ${eventLimit.type} ahead) for calendar`, name, uri)

        try {
          const data = await getContent(uri)
          // remove failed setting if it exists for calendar
          if (calendars[i].failed) {
            calendars[i] = { name, uri }
            Homey.ManagerSettings.set(this.variableMgmt.setting.icalUris, calendars)
            this.log(`getEvents: 'failed' setting value removed from calendar '${name}'`)
          }

          const activeEvents = getActiveEvents(data, eventLimit, this)
          this.log(`getEvents: Events for calendar '${name}' updated. Event count: ${activeEvents.length}`)
          calendarsEvents.push({ name, events: activeEvents })
        } catch (error) {
          const errorString = typeof error === 'object' ? error.message : error

          this.log('getEvents: Failed to get events for calendar', name, uri, errorString)

          // send exception to sentry (don't think this actually is useful)
          // sentry.captureException(err);

          // set a failed setting value to show a error message on settings page
          calendars[i] = { name, uri, failed: errorString }
          Homey.ManagerSettings.set(this.variableMgmt.setting.icalUris, calendars)
          this.log(`getEvents: 'failed' setting value added to calendar '${name}'`)
        }
      }
    } else {
      this.log('getEvents: Calendars has not been set in Settings yet')
    }

    if (this.variableMgmt.calendars && this.variableMgmt.calendars.length > 0 && calendarsEvents.length > 0) {
      const updatedCalendars = filterUpdatedCalendars(this.variableMgmt.calendars, calendarsEvents)
      triggersHandler.triggerChangedCalendars(this, updatedCalendars)
        .catch(error => {
          this.log('getEvents: Failed to trigger changed calendar events', error)
          sentry.captureException(error)
        })
    }

    const newCalendarsUids = getEventUids(calendarsEvents)
    this.log('getEvents: newCalendarsUids --', newCalendarsUids.length)
    const newlyAddedEvents = getNewEvents(oldCalendarsUids, newCalendarsUids, calendarsEvents, this)
    this.log('getEvents: newlyAddedEvents --', newlyAddedEvents.length)
    newlyAddedEvents.forEach(event => {
      triggersHandler.triggerAddedEvent(this, event, event.calendarName)
        .catch(error => {
          this.log('getEvents: Failed to trigger event added', error)
          sentry.captureException(error)
        })
    })
    Homey.ManagerSettings.set(this.variableMgmt.storage.eventUids, JSON.stringify(newCalendarsUids))

    this.variableMgmt.calendars = calendarsEvents
    sortCalendarsEvents(this.variableMgmt.calendars)

    if (reregisterCalendarTokens) {
      // unregister calendar tokens
      if (this.variableMgmt.calendarTokens.length > 0) {
        this.log('getEvents: Calendar tokens starting to flush')
        await Promise.all(this.variableMgmt.calendarTokens.map(async token => {
          this.log(`getEvents: Calendar token '${token.id}' starting to flush`)
          return token.unregister()
        }))
        this.variableMgmt.calendarTokens = []
        this.log('getEvents: Calendar tokens flushed')
      }

      // get setting for adding nextEventTokensPerCalendar
      const nextEventTokensPerCalendar = Homey.ManagerSettings.get(this.variableMgmt.setting.nextEventTokensPerCalendar)

      // register calendar tokens
      if (this.variableMgmt.calendars.length > 0) {
        await Promise.all(this.variableMgmt.calendars.map(async calendar => {
          // todays events pr calendar
          new Homey.FlowToken(`${this.variableMgmt.calendarTokensPreId}${calendar.name}${this.variableMgmt.calendarTokensPostTodayId}`, { type: 'string', title: `${Homey.__('calendarTokens.events_today_calendar_title_stamps')} ${calendar.name}` }).register()
            .then(token => {
              this.variableMgmt.calendarTokens.push(token)
              this.log(`getEvents: Registered calendarToken '${token.id}'`)
            })
          // tomorrows events pr calendar
          new Homey.FlowToken(`${this.variableMgmt.calendarTokensPreId}${calendar.name}${this.variableMgmt.calendarTokensPostTomorrowId}`, { type: 'string', title: `${Homey.__('calendarTokens.events_tomorrow_calendar_title_stamps')} ${calendar.name}` }).register()
            .then(token => {
              this.variableMgmt.calendarTokens.push(token)
              this.log(`getEvents: Registered calendarToken '${token.id}'`)
            })

          if (nextEventTokensPerCalendar) {
            // next event title pr calendar
            new Homey.FlowToken(`${this.variableMgmt.calendarTokensPreId}${calendar.name}${this.variableMgmt.calendarTokensPostNextTitleId}`, { type: 'string', title: `${Homey.__('calendarTokens.event_next_title_calendar')} ${calendar.name}` }).register()
              .then(token => {
                this.variableMgmt.calendarTokens.push(token)
                this.log(`getEvents: Registered calendarToken '${token.id}'`)
              })
            // next event start date pr calendar
            new Homey.FlowToken(`${this.variableMgmt.calendarTokensPreId}${calendar.name}${this.variableMgmt.calendarTokensPostNextStartDateId}`, { type: 'string', title: `${Homey.__('calendarTokens.event_next_startdate_calendar')} ${calendar.name}` }).register()
              .then(token => {
                this.variableMgmt.calendarTokens.push(token)
                this.log(`getEvents: Registered calendarToken '${token.id}'`)
              })
            // next event start time pr calendar
            new Homey.FlowToken(`${this.variableMgmt.calendarTokensPreId}${calendar.name}${this.variableMgmt.calendarTokensPostNextStartTimeId}`, { type: 'string', title: `${Homey.__('calendarTokens.event_next_startstamp_calendar')} ${calendar.name}` }).register()
              .then(token => {
                this.variableMgmt.calendarTokens.push(token)
                this.log(`getEvents: Registered calendarToken '${token.id}'`)
              })
            // next event end date pr calendar
            new Homey.FlowToken(`${this.variableMgmt.calendarTokensPreId}${calendar.name}${this.variableMgmt.calendarTokensPostNextEndDateId}`, { type: 'string', title: `${Homey.__('calendarTokens.event_next_enddate_calendar')} ${calendar.name}` }).register()
              .then(token => {
                this.variableMgmt.calendarTokens.push(token)
                this.log(`getEvents: Registered calendarToken '${token.id}'`)
              })
            // next event end time pr calendar
            new Homey.FlowToken(`${this.variableMgmt.calendarTokensPreId}${calendar.name}${this.variableMgmt.calendarTokensPostNextEndTimeId}`, { type: 'string', title: `${Homey.__('calendarTokens.event_next_endstamp_calendar')} ${calendar.name}` }).register()
              .then(token => {
                this.variableMgmt.calendarTokens.push(token)
                this.log(`getEvents: Registered calendarToken '${token.id}'`)
              })
          }
        }))
      }
    }

    this.isGettingEvents = false

    return true
  }

  async triggerEvents () {
    // update flow tokens and trigger events IF events exists
    if (this.variableMgmt.calendars && this.variableMgmt.calendars.length > 0) {
      // first, update flow tokens, then trigger events
      await triggersHandler.updateTokens(this)
        .catch(error => {
          this.log('app.triggerEvents: Failed in updateTokens Promise:', error)

          // send exception to sentry
          sentry.captureException(error)
        })

      await triggersHandler.triggerEvents(this)
        .catch(error => {
          this.log('app.triggerEvents: Failed in triggerEvents Promise:', error)

          // send exception to sentry
          sentry.captureException(error)
        })
    }
  }

  async unregisterCronTasks () {
    await Homey.ManagerCron.unregisterAllTasks()
  }

  async registerCronTasks () {
    await this.unregisterCronTasks()

    try {
      const cronTaskUpdateCalendar = await Homey.ManagerCron.registerTask(this.variableMgmt.crontask.id.updateCalendar, this.variableMgmt.crontask.schedule.updateCalendar)
      cronTaskUpdateCalendar.on('run', () => {
        if (!this.isGettingEvents) {
          this.log('onInit/cronTask: Triggering getEvents without reregistering of tokens')
          this.getEvents()
        }
      })
    } catch (error) {
      this.log(`registerCronTasks: Failed to register task '${this.variableMgmt.crontask.id.updateCalendar}'`, error)

      sentry.captureException(error)
    }

    try {
      const cronTaskTriggerEvents = await Homey.ManagerCron.registerTask(this.variableMgmt.crontask.id.triggerEvents, this.variableMgmt.crontask.schedule.triggerEvents)
      cronTaskTriggerEvents.on('run', () => this.triggerEvents())
    } catch (error) {
      this.log(`registerCronTasks: Failed to register task '${this.variableMgmt.crontask.id.triggerEvents}'`, error)

      sentry.captureException(error)
    }
  }
}

module.exports = IcalCalendar
