// The Agents connector (shared_agentnode), described for the managed apps data client.
//
// `ms app add data-source --connector shared_agentnode --as action` generates a service for the two
// actions the connector lists (InvokeAgent, InvokeDefinition). Running an agent is a long-running
// call: it answers 202 with a conversation id and the answer is read from the status operation,
// which the connector marks internal and the generator leaves out. This file adds those operations
// for the same data source, next to the generated code rather than inside it.
//
// Paths and parameters are the connector's own definition, read 28 Sep 2026.
import type { getClient } from '@microsoft/managed-apps/data'

export const AGENT_DATA_SOURCE = 'agentnode'

const connectionId = { name: 'connectionId', in: 'path', required: true, type: 'string' }
const conversationId = { name: 'conversationId', in: 'path', required: true, type: 'string' }
const body = { name: 'body', in: 'body', required: true, type: 'object' }
const accepted = { '200': { type: 'object' }, '201': { type: 'object' }, '202': { type: 'object' }, default: { type: 'void' } }

const published = '/{connectionId}/copilotflows/agentnodes/published/conversations'
const standard = '/{connectionId}/powerautomate/agentnodes/conversations'

export const agentDataSources: Parameters<typeof getClient>[0] = {
  [AGENT_DATA_SOURCE]: {
    tableId: '',
    version: '',
    primaryKey: '',
    dataSourceType: 'Connector',
    apis: {
      InvokeAgent_V2: { path: published, method: 'POST', parameters: [connectionId, body], responseInfo: accepted },
      GetConversationStatus_V2: { path: `${published}/{conversationId}`, method: 'GET', parameters: [connectionId, conversationId], responseInfo: accepted },
      CancelConversation_V2: { path: `${published}/{conversationId}`, method: 'DELETE', parameters: [connectionId, conversationId], responseInfo: accepted },
      InvokeAgent: { path: standard, method: 'POST', parameters: [connectionId, body], responseInfo: accepted },
      GetConversationStatus: { path: `${standard}/{conversationId}`, method: 'GET', parameters: [connectionId, conversationId], responseInfo: accepted },
      CancelConversation: { path: `${standard}/{conversationId}`, method: 'DELETE', parameters: [connectionId, conversationId], responseInfo: accepted },
      ListAgents: { path: '/{connectionId}/powerautomate/agentnodes/agents', method: 'GET', parameters: [connectionId], responseInfo: accepted },
    },
  },
}
