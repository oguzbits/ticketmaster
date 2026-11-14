import { z } from 'zod';

import { LOCAL_MAILPIT_ORIGIN } from '../../../testing/mock-server.js';

/** The REST API of the local Mailpit (`pnpm db:up`); specs read what the SMTP adapter sent. */
const MAILPIT_API = `${LOCAL_MAILPIT_ORIGIN}/api/v1`;

const SearchSchema = z.object({
  messages: z.array(z.object({ ID: z.string(), Subject: z.string() })),
});
const MessageSchema = z.object({
  Text: z.string(),
  Attachments: z.array(z.object({ PartID: z.string(), FileName: z.string() })),
});

export interface ReceivedMail {
  subject: string;
  text: string;
  attachments: { filename: string; content: Buffer }[];
}

async function get(path: string): Promise<Response> {
  const response = await fetch(`${MAILPIT_API}${path}`);
  if (!response.ok) throw new Error(`Mailpit ${path} answered ${response.status}`);
  return response;
}

/** Every mail sent to the address, oldest first. Specs use an address of their own per test. */
export async function mailsTo(address: string): Promise<ReceivedMail[]> {
  const found = SearchSchema.parse(
    await (await get(`/search?query=${encodeURIComponent(`to:${address}`)}`)).json()
  );
  return Promise.all(
    [...found.messages].reverse().map(async ({ ID, Subject }) => {
      const message = MessageSchema.parse(await (await get(`/message/${ID}`)).json());
      const attachments = await Promise.all(
        message.Attachments.map(async ({ PartID, FileName }) => ({
          filename: FileName,
          content: Buffer.from(await (await get(`/message/${ID}/part/${PartID}`)).arrayBuffer()),
        }))
      );
      return { subject: Subject, text: message.Text, attachments };
    })
  );
}
