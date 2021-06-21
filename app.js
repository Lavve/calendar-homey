'use strict'

const { sentry, init } = require('./lib/sentry-io') // { sentry, init, startTransaction }

const Homey = require('homey')
const IntervalClock = require('interval-clock')

const getDateTimeFormat = require('./lib/get-datetime-format')
const getContent = require('./lib/get-ical-content')
const getActiveEvents = require('./lib/get-active-events')
const sortCalendarsEvents = require('./lib/sort-calendars')
const { generateTokens, generatePerCalendarTokens } = require('./lib/generate-token-configuration')

const triggersHandler = require('./handlers/triggers')
const conditionsHandler = require('./handlers/conditions')
const actionsHandler = require('./handlers/actions')

class IcalCalendar extends Homey.App {
  async onInit () {
    this.log(`${Homey.manifest.name.en} v${Homey.manifest.version} is running on ${this.homey.version}...`)

    // set a variable to control if getEvents is already running
    this.isGettingEvents = false

    // initialize sentry.io
    init(this.homey)
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
    this.log('onInit: Triggering getEvents and reregistering tokens')
    this.getEvents(true)

    // register callback when settings has been set
    this.homey.settings.on('set', args => {
      if (args && (args === this.variableMgmt.setting.icalUris || args === this.variableMgmt.setting.eventLimit || args === this.variableMgmt.setting.nextEventTokensPerCalendar)) {
        // sync calendars when calendar specific settings have been changed
        if (!this.isGettingEvents) {
          this.log(`onInit/${args}: Triggering getEvents and reregistering tokens`)
          this.getEvents(true)
        }
      } else if (args && (args === this.variableMgmt.setting.dateFormat || args === this.variableMgmt.setting.timeFormat)) {
        // get new date/time format
        this.variableMgmt.dateTimeFormat = getDateTimeFormat(this)
      }
    })

    // register cron tasks for updateCalendar and triggerEvents
    this.registerIntervals()
  }

  async getEvents (reregisterCalendarTokens = false) {
    this.isGettingEvents = true

    // get URI from settings
    const calendars = this.homey.settings.get(this.variableMgmt.setting.icalUris)
    // get event limit from settings or use the default
    const eventLimit = this.homey.settings.get(this.variableMgmt.setting.eventLimit) || this.variableMgmt.setting.eventLimitDefault
    const calendarsEvents = []

    // get ical events
    if (calendars) {
      this.log('getEvents: Getting calendars:', calendars.length)

      for (let i = 0; i < calendars.length; i++) {
        let { name, uri } = calendars[i]
        if (uri === '') {
          this.log(`getEvents: Calendar '${name}' has empty uri. Skipping...`)
          continue
        } else if (!/(http|https|webcal):\/\/.+/.exec(uri)) {
          this.log(`getEvents: Uri for calendar '${name}' is invalid. Skipping...`)
          calendars[i] = { name, uri, failed: `Uri for calendar '${name}' is invalid` }
          this.homey.settings.set(this.variableMgmt.setting.icalUris, calendars)
          this.log(`getEvents: Added 'failed' setting value to calendar '${name}'`)
          continue
        }

        if (/webcal:\/\/.+/.exec(uri)) {
          uri = uri.replace('webcal://', 'https://')
          this.log(`getEvents: Calendar '${name}': webcal found and replaced with https://`)
          calendars[i] = { name, uri }
          this.homey.settings.set(this.variableMgmt.setting.icalUris, calendars)
        }

        this.log(`getEvents: Getting events (${eventLimit.value} ${eventLimit.type} ahead) for calendar`, name, uri)

        await getContent(uri)
          .then(data => {
            // remove failed setting if it exists for calendar
            if (calendars[i].failed) {
              calendars[i] = { name, uri }
              this.homey.settings.set(this.variableMgmt.setting.icalUris, calendars)
              this.log(`getEvents: Removed 'failed' setting value from calendar '${name}'`)
            }

            const activeEvents = getActiveEvents(data, eventLimit)
            this.log(`getEvents: Events for calendar '${name}' updated. Event count: ${activeEvents.length}`)
            calendarsEvents.push({ name, events: activeEvents })
          })
          .catch(error => {
            const errorString = typeof error === 'object' ? error.message : error

            this.log('getEvents: Failed to get events for calendar', name, uri, errorString)

            // set a failed setting value to show a error message on settings page
            calendars[i] = { name, uri, failed: errorString }
            this.homey.settings.set(this.variableMgmt.setting.icalUris, calendars)
            this.log(`getEvents: Added 'failed' setting value to calendar '${name}'`)
          })
      }
    } else {
      this.log('getEvents: Calendars has not been set in Settings yet')
    }

    this.variableMgmt.calendars = calendarsEvents
    sortCalendarsEvents(this.variableMgmt.calendars)

    if (reregisterCalendarTokens) {
      // unregister calendar tokens
      if (this.variableMgmt.calendarTokens.length > 0) {
        this.log('getEvents: Calendar tokens starting to flush')
        await Promise.all(this.variableMgmt.calendarTokens.map(async token => {
          this.log(`getEvents: Calendar token '${token.id}' starting to flush`)
          return token.unregisterToken()
        }))
        this.variableMgmt.calendarTokens = []
        this.log('getEvents: Calendar tokens flushed')
      }

      // get setting for adding nextEventTokensPerCalendar
      const nextEventTokensPerCalendar = this.homey.settings.get(this.variableMgmt.setting.nextEventTokensPerCalendar)

      // register calendar tokens
      if (this.variableMgmt.calendars.length > 0) {
        await Promise.all(this.variableMgmt.calendars.map(async calendar => {
          // register todays and tomorrows events pr calendar
          generateTokens(this.variableMgmt, calendar.name).map(async ({ id, type, title }) => {
            this.variableMgmt.calendarTokens.push(await this.homey.flow.createToken(id, { type, title }))
            this.log(`getEvents: Created calendar token '${id}'`)
          })

          // register next event title, next event start, next event start time, next event end date and next event end time pr calendar
          if (nextEventTokensPerCalendar) {
            generatePerCalendarTokens(this.variableMgmt, calendar.name).map(async ({ id, type, title }) => {
              this.variableMgmt.calendarTokens.push(await this.homey.flow.createToken(id, { type, title }))
              this.log(`getEvents: Created calendar token '${id}'`)
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

  async registerIntervals () {
    this.intervals = {}

    // update calendars
    this.intervals.updateCalendars = IntervalClock('1m')
    this.intervals.updateCalendars.on('tick', () => {
      if (!this.isGettingEvents) {
        this.log('registerIntervals/updateCalendars: Updating calendars without reregistering tokens')
        this.getEvents()
      }
    })
    this.log(`registerIntervals: Calendars update setup for every 15th minute`)

    // event triggers
    this.intervals.triggers = IntervalClock('1m')
    this.intervals.triggers.on('tick', () => {
      if (!this.isGettingEvents) {
        this.log('registerIntervals/triggers: Triggering events')
        this.triggerEvents()
      }
    })
    this.log(`registerIntervals: Triggering events setup for every 1 minute`)
  }
}

module.exports = IcalCalendar
