import 'dotenv/config'
import {JSONRPCClient, JSONRPCServer, JSONRPCServerAndClient} from 'json-rpc-2.0'
import {v5 as uuid} from 'uuid'
import { WebSocket } from 'ws'
import OpenAI from 'openai'

import {EVNTBOARD_HOST, MODULE_CODE, MODULE_NAME, MODULE_TOKEN} from './constant'

const main = async () => {

  if (!EVNTBOARD_HOST) {
    throw new Error("EVNTBOARD_HOST not set")
  }

  if (!MODULE_NAME) {
    throw new Error("MODULE_NAME not set")
  }

  if (!MODULE_TOKEN) {
    throw new Error("MODULE_TOKEN not set")
  }

  let ws: WebSocket

  const serverAndClient = new JSONRPCServerAndClient(
    new JSONRPCServer(),
    new JSONRPCClient((request) => {
      try {
        ws.send(JSON.stringify(request))
        return Promise.resolve()
      } catch (error) {
        return Promise.reject(error)
      }
    }, () => uuid())
  )

  ws = new WebSocket(EVNTBOARD_HOST)

  ws.onopen = async () => {
    const result = await serverAndClient.request('session.register', {
      code: MODULE_CODE,
      name: MODULE_NAME,
      token: MODULE_TOKEN
    })

    let apiKey = result?.find((c: { key: string, value: string }) => c.key === 'apiKey')?.value ?? undefined

    const openai = new OpenAI({ apiKey })

    serverAndClient.addMethod('getAssistants', async () => {
      const assistants = await openai.beta.assistants.list()
      return assistants
    })

    serverAndClient.addMethod('getAssistant', async ({ assistantId }) => {
      const assistant = await openai.beta.assistants.retrieve(assistantId)
      return assistant
    })

    serverAndClient.addMethod('createThread', async ({ messages }) => {
      const thread = await openai.beta.threads.create({
        messages
      })
      return thread
    })

    serverAndClient.addMethod('addMessage', async({ threadId, role='user', content }) => {
      const message = await openai.beta.threads.messages.create(threadId, {
        role,
        content
      })

      return message
    })

    serverAndClient.addMethod('runThread', async ({ threadId, assistant_id, additional_instructions }) => {
      const run = await openai.beta.threads.runs.create(threadId, {
        assistant_id,
        additional_instructions
      })
      return run
    })

    serverAndClient.addMethod('getRunStatus', async ({ threadId, runId }) => {
      const runStatus = await openai.beta.threads.runs.retrieve(threadId, runId)

      return runStatus
    })

    serverAndClient.addMethod('getRunSteps', async ({ threadId, runId }) => {
      const runSteps = await openai.beta.threads.runs.steps.list(threadId, runId)
      return runSteps
    })

    serverAndClient.addMethod('getMessages', async ({ threadId }) => {
      const messages = await openai.beta.threads.messages.list(threadId)
      return messages
    })

    serverAndClient.addMethod('getMessage', async ({ threadId, messageId }) => {
      const message = await openai.beta.threads.messages.retrieve(threadId, messageId)
      return message
    })

    serverAndClient.addMethod('getRuns', async ({ threadId }) => {
      const runs = await openai.beta.threads.runs.list(threadId)
      return runs
    })

    serverAndClient.addMethod('submitToolOutputs', async ({ threadId, runId, outputs }) => {
      const run = await openai.beta.threads.runs.submitToolOutputs(threadId, runId, { tool_outputs: outputs })
      return run
    })

    serverAndClient.addMethod('vision', async ({ prompt, image, additional_instructions }) => {
      let assistant_prompt: any[] = []
      if (additional_instructions) {
        assistant_prompt = [{
          role: 'system',
          content: [{
            type: 'text',
            content: additional_instructions
          }]
        }]
      }
      const response = await openai.chat.completions.create({
        model: 'gpt-4-vision-preview',
        messages: [...assistant_prompt, {
          role: "user",
          content: [{
            type: "text", text: prompt
          }, {
            type: 'image_url',
            image_url: {
              "url": image
            }
          }]
        }]
      })
      return response
    })

    serverAndClient.addMethod('dalle', async ({ prompt, n = '1', size = "1024x1024", quality = 'standard' }) => {
      const namespace = '99c37adf-a97b-418b-9121-95db5ee94faa'
      const queueId = uuid('dalle', namespace)
      openai.images.generate({
        model: "dall-e-3",
        prompt: prompt,
        size: size,
        quality: quality,
        n: n
      }).then((response) => {
        const output = response.data.map(resp => resp.url)
        console.log('dalle-complete', output)

        serverAndClient.notify('event.new', {
          name: `${MODULE_CODE}-queue-state-changed`,
          payload: {id: queueId, state: 'completed', output}
        })
      })
      console.log('dalle-pending', { queueId })

      return { type: 'queue', message: { state: 'in_progress', id: queueId } }
    })
  }

  ws.onmessage = (event: { data: { toString: () => string } }) => {
    serverAndClient.receiveAndSend(JSON.parse(event.data.toString()))
  }

  ws.onclose = (event: { reason: any }) => {
    serverAndClient.rejectAllPendingRequests(`Connection is closed (${event.reason}).`)
  }

  ws.onerror = (event: any) => {
    console.error('error a', event)
  }
}

main()
  .catch((e) => {
    console.error(e)
  })
