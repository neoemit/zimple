import { readConfigFromEnv } from './defaults.js'
import { createServer } from './server.js'

const bootstrap = async (): Promise<void> => {
  const config = readConfigFromEnv()
  const server = await createServer(config)

  try {
    await server.listen({
      host: config.bindAddress,
      port: config.port,
    })
    server.log.info(
      `Zimple web mode listening on http://${config.bindAddress}:${config.port}`,
    )
  } catch (error) {
    server.log.error(error, 'Failed to start Zimple web mode')
    process.exitCode = 1
  }
}

void bootstrap()
