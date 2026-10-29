const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

interface MailpitAddress {
  Address: string;
}

interface MailpitMessageSummary {
  ID: string;
  To: MailpitAddress[];
  From: MailpitAddress;
  Subject: string;
}

interface MailpitMessageDetail extends MailpitMessageSummary {
  HTML: string;
}

export async function getMailpitMessages(): Promise<MailpitMessageSummary[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data = (await res.json()) as { messages?: MailpitMessageSummary[] };
  return data.messages ?? [];
}

export async function getMailpitMessage(
  id: string,
): Promise<MailpitMessageDetail> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return (await res.json()) as MailpitMessageDetail;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}
