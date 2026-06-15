import cron from 'node-cron';
import type { Client } from 'discord.js';
import { getPendingTasks } from '../services/notion.js';
import { env } from '../config/env.js';

export function startNotionStandupScheduler(client: Client<true>) {
  cron.schedule('0 9 * * 1-5', async () => {
    try {
      console.log('Running Jolyne Notion Standup Scheduler...');
      const channelId = env.NOTION_STANDUP_CHANNEL_ID || '1501899831268868106';
      const channel = await client.channels.fetch(channelId);
      
      if (!channel?.isTextBased() || !("send" in channel)) {
        console.error('Standup channel is not text based or not found.');
        return;
      }

      const tasks = await getPendingTasks();
      if (tasks.length === 0) {
        await channel.send('🎉 **Daily Standup:** Tidak ada tugas Jolyne yang tertunda hari ini. Kerja bagus!');
        return;
      }

      const list = tasks.map(t => {
        const title = t.properties['Task']?.title[0]?.plain_text || 'Untitled';
        const priority = t.properties['Priority']?.select?.name || 'Low';
        const status = t.properties['Status']?.select?.name || 'Not started';
        const emoji = priority.includes('High') ? '🔴' : (priority.includes('Medium') ? '🟡' : '🟢');
        return `${emoji} **${title}** (${status})`;
      }).join('\n');

      const message = `Halo Tuan! Selamat Pagi ☕\nBerikut adalah rekap tugas **Jolyne Tracker** Anda yang belum selesai:\n\n${list}`;
      await channel.send(message);

    } catch (error) {
      console.error('Error in Notion Standup Scheduler:', error);
    }
  }, {
    timezone: "Asia/Jakarta"
  });

  console.log(`Notion Standup scheduler aktif untuk channel ${env.NOTION_STANDUP_CHANNEL_ID}.`);
}
