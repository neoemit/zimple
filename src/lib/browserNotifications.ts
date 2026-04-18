import type { JobSummary } from './types'

const isSupported = (): boolean =>
  typeof window !== 'undefined' && typeof Notification !== 'undefined'

const stateLabel = (state: JobSummary['state']): string => {
  if (state === 'succeeded') {
    return 'succeeded'
  }
  if (state === 'failed') {
    return 'failed'
  }
  return 'cancelled'
}

const notificationBody = (summary: JobSummary): string => {
  const url = summary.url
  if (summary.state === 'failed' && summary.errorMessage) {
    return `${url}\n${summary.errorMessage}`
  }
  if (summary.state === 'succeeded' && summary.outputPath) {
    return `${url}\nOutput: ${summary.outputPath}`
  }
  return url
}

export const ensureCompletionNotificationPermission = async (): Promise<NotificationPermission> => {
  if (!isSupported()) {
    return 'denied'
  }

  const permission = Notification.permission
  if (permission !== 'default') {
    return permission
  }

  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

export const sendJobCompletionNotification = async (
  summary: JobSummary,
): Promise<boolean> => {
  if (!isSupported()) {
    return false
  }

  let permission = Notification.permission
  if (permission === 'default') {
    permission = await ensureCompletionNotificationPermission()
  }

  if (permission !== 'granted') {
    return false
  }

  try {
    new Notification(`Zimple capture ${stateLabel(summary.state)}`, {
      body: notificationBody(summary),
      tag: `zimple-job-${summary.id}`,
    })
    return true
  } catch {
    return false
  }
}
