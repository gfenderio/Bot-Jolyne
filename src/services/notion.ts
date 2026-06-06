import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID!;

export async function addNotionTask(taskName: string, urgency: string = 'Medium', project: string = 'Jolyne') {
  try {
    const response = await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        'Task Name': {
          title: [
            {
              text: { content: taskName }
            }
          ]
        },
        'Status': {
          status: { name: 'To-Do' }
        },
        'Project': {
          select: { name: project }
        },
        'Urgency': {
          select: { name: urgency }
        }
      }
    });
    return response;
  } catch (error) {
    console.error('Error adding task to Notion:', error);
    throw error;
  }
}

export async function getPendingTasks(project: string = 'Jolyne') {
  try {
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        and: [
          {
            property: 'Project',
            select: { equals: project }
          },
          {
            property: 'Status',
            status: { does_not_equal: 'Done' }
          }
        ]
      },
      sorts: [
        {
          property: 'Urgency',
          direction: 'descending'
        }
      ]
    });
    return response.results as any[];
  } catch (error) {
    console.error('Error getting tasks from Notion:', error);
    throw error;
  }
}
