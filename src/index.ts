#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { tools } from './tools/index.js';
import { Tool, ToolResponse, GenerateImageArgs, EditImageArgs, VariationArgs, ValidateKeyArgs } from './types/index.js';

// Express ilovasini yaratish
const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// Server yaratish funksiyasi
const getServer = () =>
  new Server(
    {
      name: 'dalle-image-generator',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {
          generate_image: true,
          edit_image: true,
          create_variation: true,
          validate_key: true,
        },
      },
    }
  );

/**
 * Handler that lists available tools
 */
const setListToolsHandler = (server: Server) => {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));
};

/**
 * Handler for tool calls
 */
const setToolCallHandler = (server: Server) => {
  server.setRequestHandler(CallToolRequestSchema, async (request, _extra) => {
    try {
      const tool = tools.find((t) => t.name === request.params.name);
      if (!tool) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unknown tool: ${request.params.name}`,
            },
          ],
        } as ToolResponse;
      }

      if (tool.inputSchema.required && tool.inputSchema.required.length > 0) {
        const args = request.params.arguments || {};
        const missingArgs = tool.inputSchema.required.filter((arg) => !(arg in args));
        if (missingArgs.length > 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Missing required arguments: ${missingArgs.join(', ')}`,
              },
            ],
          } as ToolResponse;
        }
      }

      let response: ToolResponse;
      const args = request.params.arguments || {};

      switch (tool.name) {
        case 'generate_image':
          response = await (tool as Tool<GenerateImageArgs>).handler(args as unknown as GenerateImageArgs);
          break;
        case 'edit_image':
          response = await (tool as Tool<EditImageArgs>).handler(args as unknown as EditImageArgs);
          break;
        case 'create_variation':
          response = await (tool as Tool<VariationArgs>).handler(args as unknown as VariationArgs);
          break;
        case 'validate_key':
          response = await (tool as Tool<ValidateKeyArgs>).handler({});
          break;
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${tool.name}`);
      }

      if (request.params._meta) {
        return {
          ...response,
          _meta: request.params._meta,
        };
      }

      return response;
    } catch (error) {
      console.error('Tool execution error:', error);
      return {
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : 'An unexpected error occurred',
          },
        ],
      } as ToolResponse;
    }
  });
};

/**
 * HTTP endpoint for MCP tool calls
 */
app.post('/mcp', async (req: Request, res: Response) => {
  const server = getServer();
  setListToolsHandler(server);
  setToolCallHandler(server);
    
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }

  res.on('close', () => {
    console.log('Request closed');
    transport.close();
    server.close();
  });
});

/**
 * Unsupported methods (GET and DELETE)
 */
app.get('/mcp', async (_req: Request, res: Response) => {
  res.writeHead(200).end(
    JSON.stringify({
      list: tools
    })
  );
});

app.delete('/mcp', async (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.',
      },
      id: null,
    })
  );
});

/**
 * Start the server
 */
async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY environment variable is required. See README.md for setup instructions.');
    process.exit(1);
  }

  app.listen(port, () => {
    console.log(`MCP Stateless Streamable HTTP Server listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});