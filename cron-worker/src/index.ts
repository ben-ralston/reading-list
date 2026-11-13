import { getEndpoint } from './dispatch'

interface Env {
  DEPLOY_URL: string
  CRON_SECRET: string
}

export default {
  // Errors thrown here surface as failed invocations in Cloudflare's cron history,
  // which is the only built-in alerting we have on this Worker.
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const path = getEndpoint(event.cron)
    if (!path) {
      throw new Error(`No endpoint mapped for cron: ${event.cron}`)
    }
    const url = `${env.DEPLOY_URL}${path}`

    let res: Response
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      })
    } catch (err) {
      throw new Error(`${path} request error: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '<no body>')
      throw new Error(`${path} failed: ${res.status} ${body}`)
    }
    console.log(`${path} succeeded (${res.status})`)
  },
} satisfies ExportedHandler<Env>
