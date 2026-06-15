import { Client } from '@notionhq/client';
import { env } from '../config/env.js';

const notion = new Client({ auth: env.NOTION_TOKEN });

// Tasks database IDs
const TASK_DB_ID = env.NOTION_TASK_DATABASE_ID!;
// data_source_id for querying (different from database_id in notion v5 client)
const TASK_DS_ID = 'f7ecbebd-d7c0-4516-936e-bbf2be0fdd38';

function normalizePriority(input: string): string {
  const lower = input.trim().toLowerCase();
  if (['high', 'h', 'tinggi'].includes(lower)) return '\U0001f534 High';
  if (['low', 'l', 'rendah'].includes(lower)) return '\U0001f7e2 Low';
  return '\U0001f7e1 Medium';
}

function normalizeProject(input: string): string {
  const trimmed = input.trim();
  const map: Record<string, string> = {
    'machitan': 'Machitan',
    'bot-jolyne': 'Bot-Jolyne',
    'bot jolyne': 'Bot-Jolyne',
    'jolyne': 'Bot-Jolyne',
    'operasional': 'Operasional',
    'ops': 'Operasional',
    'infra': 'Infra',
    'lainnya': 'Lainnya',
  };
  return map[trimmed.toLowerCase()] ?? trimmed;
}

export async function createTask(params: {
  name: string;
  priority: string;
  project: string;
  description?: string;
}) {
  return notion.pages.create({
    parent: { database_id: TASK_DB_ID },
    properties: {
      'Task': {
        title: [{ text: { content: params.name } }]
      },
      'Status': {
        select: { name: 'Not started' }
      },
      'Priority': {
        select: { name: normalizePriority(params.priority) }
      },
      'Project': {
        select: { name: normalizeProject(params.project) }
      },
      ...(params.description?.trim() ? {
        'Deskripsi': {
          rich_text: [{ text: { content: params.description } }]
        }
      } : {}),
    },
  });
}

export async function getPendingTasks() {
  // @ts-ignore — dataSources.query exists at runtime but missing from @notionhq/client v5 types
  const response = await notion.dataSources.query({
    data_source_id: TASK_DS_ID,
    filter: {
      property: 'Status',
      select: { does_not_equal: 'Done' }
    },
    sorts: [{ property: 'Priority', direction: 'ascending' }],
  });
  return response.results as any[];
}
