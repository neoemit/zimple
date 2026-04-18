import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import type { StartJobRequest, WebApiConfig } from './types.js'
import { JobManager } from './job-manager.js'

const currentDir = path.dirname(fileURLToPath(import.meta.url))

const frontendDistPath = (): string => {
  if (process.env.ZIMPLE_FRONTEND_DIST) {
    return path.resolve(process.env.ZIMPLE_FRONTEND_DIST)
  }
  return path.resolve(currentDir, '..', '..', 'dist')
}

interface ServerOptions {
  manager?: JobManager
}

export const createServer = async (config: WebApiConfig, options?: ServerOptions) => {
  const manager = options?.manager ?? (await JobManager.create(config))
  const app = Fastify({
    logger: true,
  })

  const staticRoot = frontendDistPath()
  if (fs.existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      index: ['index.html'],
      wildcard: false,
    })
  } else {
    app.log.warn(
      `Frontend dist directory not found at ${staticRoot}. API routes will work but UI will not be served.`,
    )
  }

  app.get('/api/runtime-health', async () => manager.getRuntimeHealth())

  app.get('/api/settings', async () => manager.getSettings())

  app.put('/api/settings', async (request, reply) => {
    const body = request.body as Partial<{
      outputDirectory: string | null
      autoOpenOnSuccess: boolean
    }>

    try {
      const saved = await manager.setSettings({
        outputDirectory:
          typeof body.outputDirectory === 'string' || body.outputDirectory === null
            ? body.outputDirectory
            : undefined,
        autoOpenOnSuccess: body.autoOpenOnSuccess !== false,
      })
      return saved
    } catch (error) {
      reply.code(400)
      return { message: (error as Error).message }
    }
  })

  app.post('/api/jobs', async (request, reply) => {
    try {
      const result = await manager.startJob(request.body as StartJobRequest)
      return result
    } catch (error) {
      reply.code(400)
      return { message: (error as Error).message }
    }
  })

  app.get('/api/jobs', async () => manager.listJobs())

  app.get('/api/jobs/:jobId', async (request, reply) => {
    const params = request.params as { jobId: string }
    const detail = manager.getJob(params.jobId)
    if (!detail) {
      reply.code(404)
      return { message: `Unknown job id: ${params.jobId}` }
    }
    return detail
  })

  app.get('/api/jobs/:jobId/progress', async (request, reply) => {
    const params = request.params as { jobId: string }
    const query = request.query as Partial<{ after: string; limit: string }>
    const parsedAfter = Number.parseInt(query.after ?? '-1', 10)
    const parsedLimit = Number.parseInt(query.limit ?? '120', 10)
    const after = Number.isNaN(parsedAfter) ? -1 : parsedAfter
    const limit = Number.isNaN(parsedLimit) ? 120 : parsedLimit

    const delta = manager.getJobProgressDelta(params.jobId, after, limit)
    if (!delta) {
      reply.code(404)
      return { message: `Unknown job id: ${params.jobId}` }
    }

    return delta
  })

  app.post('/api/jobs/:jobId/cancel', async (request) => {
    const params = request.params as { jobId: string }
    return manager.cancelJob(params.jobId)
  })

  app.get('/api/jobs/:jobId/output', async (request, reply) => {
    const params = request.params as { jobId: string }
    const outputPath = manager.getOutputPath(params.jobId)
    if (!outputPath) {
      reply.code(404)
      return { message: 'No output file is available for this job yet.' }
    }

    if (!fs.existsSync(outputPath)) {
      reply.code(404)
      return { message: 'Output file path no longer exists on disk.' }
    }

    const fileName = (manager.getOutputFilename(params.jobId) || 'output.zim').replace(
      /"/g,
      '',
    )
    reply.header('Content-Type', manager.getOutputMimeType(params.jobId))
    reply.header('Content-Disposition', `attachment; filename="${fileName}"`)
    return reply.send(fs.createReadStream(outputPath))
  })

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404)
      return { message: 'Not found' }
    }

    if (fs.existsSync(path.join(staticRoot, 'index.html'))) {
      return reply.sendFile('index.html')
    }

    reply.code(404)
    return { message: 'Frontend build not found.' }
  })

  return app
}
