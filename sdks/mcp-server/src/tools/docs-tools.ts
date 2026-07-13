import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '@clawrent/provider';

export function registerDocsTools(server: McpServer, client: ApiClient): void {
  // --- Read (public, no auth needed) ---

  server.tool(
    'clawrent_docs_tree',
    'Get the published documentation tree structure of ClawRent platform',
    {},
    async () => {
      try {
        const result = await client.getDocsTree();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'clawrent_docs_read',
    'Read a specific document by its full path (e.g. "getting-started/quick-start")',
    {
      path: z.string().describe('Full path of the document (e.g. "getting-started/quick-start")'),
    },
    async ({ path }) => {
      try {
        const result = await client.getDocByPath(path);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'clawrent_docs_search',
    'Search published documentation by keyword (searches title and content)',
    {
      query: z.string().describe('Search keyword'),
    },
    async ({ query }) => {
      try {
        const result = await client.searchDocs(query);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- Write (admin agents only) ---

  server.tool(
    'clawrent_docs_create',
    'Create a new document or folder in the doc CMS. Requires admin permissions.',
    {
      type: z.enum(['folder', 'document']).describe('Node type: "folder" or "document"'),
      title: z.string().describe('Document or folder title'),
      parentId: z.string().optional().describe('Parent folder ID (omit for root level)'),
      content: z.string().optional().describe('Markdown content (for documents)'),
      slug: z.string().optional().describe('URL-friendly slug (auto-generated from title if omitted)'),
      icon: z.string().optional().describe('Icon emoji or identifier'),
    },
    async ({ type, title, parentId, content, slug, icon }) => {
      try {
        const result = await client.createDoc({ type, title, parentId, content, slug, icon });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('403')) {
          return {
            content: [{ type: 'text' as const, text: 'Permission denied: This operation requires admin privileges with mcp.docs.create permission.' }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'clawrent_docs_update',
    'Update an existing document (title, content, etc.). Requires admin permissions.',
    {
      id: z.string().describe('Document ID to update'),
      title: z.string().optional().describe('New title'),
      content: z.string().optional().describe('New markdown content'),
      changeSummary: z.string().optional().describe('Brief summary of what changed (for version history)'),
    },
    async ({ id, title, content, changeSummary }) => {
      try {
        const data: Record<string, string> = {};
        if (title !== undefined) data['title'] = title;
        if (content !== undefined) data['content'] = content;
        if (changeSummary !== undefined) data['changeSummary'] = changeSummary;
        const result = await client.updateDoc(id, data);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('403')) {
          return {
            content: [{ type: 'text' as const, text: 'Permission denied: This operation requires admin privileges with mcp.docs.edit permission.' }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'clawrent_docs_delete',
    'Delete a document or folder from the doc CMS. Requires admin permissions.',
    {
      id: z.string().describe('Document or folder ID to delete'),
    },
    async ({ id }) => {
      try {
        await client.deleteDoc(id);
        return {
          content: [{ type: 'text' as const, text: `Document ${id} deleted successfully.` }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('403')) {
          return {
            content: [{ type: 'text' as const, text: 'Permission denied: This operation requires admin privileges with mcp.docs.delete permission.' }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'clawrent_docs_publish',
    'Publish or unpublish a document. Requires admin permissions.',
    {
      id: z.string().describe('Document ID'),
      action: z.enum(['publish', 'unpublish']).describe('Action: "publish" or "unpublish"'),
    },
    async ({ id, action }) => {
      try {
        const result = action === 'publish'
          ? await client.publishDoc(id)
          : await client.unpublishDoc(id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('403')) {
          return {
            content: [{ type: 'text' as const, text: 'Permission denied: This operation requires admin privileges with mcp.docs.publish permission.' }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
