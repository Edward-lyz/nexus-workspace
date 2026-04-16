import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const dbPath = join(tmpdir(), `nexus-integration-${process.pid}.sqlite`)
const workspacePath = join(tmpdir(), `nexus-agent-sandbox-${process.pid}`)

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'zig',
      ['run', 'integration-server.zig', '-lc', '-lsqlite3', '-lutil', '-framework', 'Foundation'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NEXUS_INTEGRATION_DB_PATH: dbPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let settled = false
    let output = ''

    const finish = (value, isError = false) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('exit', onExit)
      if (isError) reject(value)
      else resolve(value)
    }

    const onData = (chunk) => {
      output += chunk.toString()
      const match = output.match(/PORT=(\d+)/)
      if (match) {
        finish({ child, port: Number(match[1]) })
      }
    }

    const onExit = (code, signal) => {
      finish(
        new Error(`integration server exited before startup: code=${code ?? 'null'} signal=${signal ?? 'null'}\\n${output}`),
        true,
      )
    }

    const timeout = setTimeout(() => {
      finish(new Error(`timed out waiting for integration server port\\n${output}`), true)
    }, 120_000)

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', onExit)
  })
}

class RpcClient {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.nextId = 0
    this.pending = new Map()
    this.messages = []
    this.watchers = new Set()

    this.ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      this.messages.push(message)

      for (const watcher of [...this.watchers]) {
        if (watcher.predicate(message)) {
          clearTimeout(watcher.timeoutId)
          this.watchers.delete(watcher)
          watcher.resolve(message)
        }
      }

      if (message.id != null && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        pending.resolve(message)
      }
    })
  }

  async open() {
    await new Promise((resolve, reject) => {
      const handleOpen = () => {
        this.ws.off('error', handleError)
        resolve()
      }
      const handleError = (error) => {
        this.ws.off('open', handleOpen)
        reject(error ?? new Error('websocket open failed'))
      }
      this.ws.once('open', handleOpen)
      this.ws.once('error', handleError)
    })
  }

  async rpc(method, params = {}, timeoutMs = 20_000) {
    this.nextId += 1
    const id = this.nextId
    const response = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc timeout: ${method}`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timeoutId)
          resolve(message)
        },
      })
    })

    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const message = await response
    if (message.error) {
      throw new Error(`${method}: ${JSON.stringify(message.error)}`)
    }
    return message.result
  }

  async waitFor(predicate, timeoutMs = 20_000) {
    for (const message of this.messages) {
      if (predicate(message)) {
        return message
      }
    }

    return new Promise((resolve, reject) => {
      const watcher = {
        predicate,
        resolve,
        timeoutId: setTimeout(() => {
          this.watchers.delete(watcher)
          reject(new Error('notification timeout'))
        }, timeoutMs),
      }
      this.watchers.add(watcher)
    })
  }

  close() {
    this.ws.close()
  }
}

async function stopServer(child) {
  if (child.exitCode != null || child.signalCode != null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5_000),
  ])
  if (child.exitCode == null && child.signalCode == null) {
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))
  }
}

async function main() {
  rmSync(dbPath, { force: true })
  rmSync(workspacePath, { recursive: true, force: true })
  mkdirSync(workspacePath, { recursive: true })
  writeFileSync(join(workspacePath, 'README.txt'), 'integration sandbox\\n')

  const { child, port } = await startServer()
  const client = new RpcClient(`ws://127.0.0.1:${port}`)

  try {
    await client.open()

    const workspace = await client.rpc('workspace.create', {
      name: 'Integration Workspace',
      path: workspacePath,
    })
    const space = await client.rpc('space.create', {
      workspace_id: workspace.id,
      name: 'Main',
      directory_path: workspacePath,
    })
    const agent = await client.rpc('agent.create', {
      space_id: space.id,
      provider_id: 'claude',
      provider_name: 'Claude Code',
    })
    const task = await client.rpc('task.create', {
      space_id: space.id,
      title: 'Integration hello',
      description: 'Say hello in one sentence, mention that the runtime started correctly, then wait for further input.',
      priority: 'medium',
    })
    const assignment = await client.rpc('task.assign', {
      task_id: task.id,
      agent_id: agent.id,
    })

    assert.ok(assignment.session_id, 'task.assign should return a session_id')

    const ptyData = await client.waitFor(
      (message) =>
        message.method === 'pty.data' &&
        message.params?.session_id === assignment.session_id,
      20_000,
    )
    const firstChunk = Buffer.from(ptyData.params.data, 'base64').toString('utf8')
    assert.match(firstChunk, /Assigned task/, 'agent session should emit kickoff output')

    await client.rpc('taskLiveOutput.save', {
      task_id: task.id,
      session_id: assignment.session_id,
      data: firstChunk,
    })
    const liveOutput = await client.rpc('taskLiveOutput.load', {
      task_id: task.id,
      session_id: assignment.session_id,
    })
    assert.match(Buffer.from(liveOutput.data, 'base64').toString('utf8'), /Assigned task/)

    const agentsBeforeKill = await client.rpc('agent.list', { space_id: space.id })
    const agentBeforeKill = agentsBeforeKill.find((row) => row.id === agent.id)
    assert.equal(agentBeforeKill?.status, 'running')
    assert.equal(agentBeforeKill?.session_id, assignment.session_id)
    assert.equal(agentBeforeKill?.assigned_task_id, task.id)

    await client.rpc('pty.kill', { session_id: assignment.session_id })

    await client.waitFor(
      (message) =>
        message.method === 'pty.exit' &&
        message.params?.session_id === assignment.session_id,
      10_000,
    )

    const agentsAfterKill = await client.rpc('agent.list', { space_id: space.id })
    const tasksAfterKill = await client.rpc('task.list', { space_id: space.id })
    const agentAfterKill = agentsAfterKill.find((row) => row.id === agent.id)
    const taskAfterKill = tasksAfterKill.find((row) => row.id === task.id)

    assert.equal(agentAfterKill?.status, 'idle')
    assert.equal(agentAfterKill?.session_id, undefined)
    assert.equal(agentAfterKill?.assigned_task_id, undefined)

    assert.equal(taskAfterKill?.status, 'todo')
    assert.equal(taskAfterKill?.queue_status, 'none')
    assert.equal(taskAfterKill?.assigned_agent_id, undefined)

    const taskRuns = await client.rpc('taskRun.list', { task_id: task.id })
    assert.equal(taskRuns.length, 1)
    assert.equal(taskRuns[0].provider_name, 'Claude Code')
    assert.equal(taskRuns[0].session_id, assignment.session_id)
    assert.equal(taskRuns[0].status, 'cancelled')
    assert.match(taskRuns[0].transcript, /Assigned task/)

    console.log(
      JSON.stringify(
        {
          port,
          session_id: assignment.session_id,
          first_chunk: firstChunk.slice(0, 160),
        },
        null,
        2,
      ),
    )
  } finally {
    client.close()
    await stopServer(child)
    rmSync(dbPath, { force: true })
    rmSync(workspacePath, { recursive: true, force: true })
  }
}

await main()
