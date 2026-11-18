import nodemailer from 'nodemailer';
import { escapeHtml } from '@sofia/shared';
import { getSecrets, getSetting } from '../lib/settings.js';

/**
 * Outbound messaging adapters. The core never talks to a provider directly — it writes to the notification
 * outbox and the worker delivers through these adapters, so providers can be swapped without touching business
 * logic. WhatsApp uses the official Meta WhatsApp Business Cloud API only (no unofficial gateways).
 */

export interface OutboundMessage {
  to: string;
  subject?: string | null;
  body: string;
  language: string;
  /** WhatsApp approved template name (required for business-initiated messages outside the 24h window). */
  providerTemplateName?: string | null;
  /** Ordered template parameters (values of the {{placeholders}} in the body, in order of appearance). */
  templateParams?: string[];
}

export interface SendResult {
  providerMessageId?: string;
}

export interface MessageAdapter {
  channel: 'whatsapp' | 'sms' | 'email' | 'push';
  /** null when ready, otherwise the reason the channel cannot send. */
  unavailableReason(): Promise<string | null>;
  send(msg: OutboundMessage): Promise<SendResult>;
}

export class PermanentSendError extends Error {}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);
/** Test seam: replace the HTTP client. */
export function setMessagingFetch(f: FetchLike): void {
  fetchImpl = f;
}

async function http(url: string, init: RequestInit): Promise<Response> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 500);
    const err = res.status >= 400 && res.status < 500 && res.status !== 429 ? new PermanentSendError(`HTTP ${res.status}: ${text}`) : new Error(`HTTP ${res.status}: ${text}`);
    throw err;
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------
export const whatsappAdapter: MessageAdapter = {
  channel: 'whatsapp',
  async unavailableReason() {
    const s = await getSetting('integrations.whatsapp');
    if (!s.enabled) return 'WhatsApp is disabled in Settings → Integrations';
    const secrets = await getSecrets<{ accessToken: string }>('whatsapp');
    if (!s.phoneNumberId || !secrets?.accessToken) return 'WhatsApp Business phone number ID / access token not configured';
    return null;
  },
  async send(msg) {
    const s = await getSetting('integrations.whatsapp');
    const secrets = await getSecrets<{ accessToken: string }>('whatsapp');
    const to = msg.to.replace(/[^\d]/g, '');
    const payload = msg.providerTemplateName
      ? {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: msg.providerTemplateName,
            language: { code: msg.language === 'ar' ? 'ar' : 'en' },
            components: msg.templateParams?.length
              ? [{ type: 'body', parameters: msg.templateParams.map((text) => ({ type: 'text', text: text || '-' })) }]
              : [],
          },
        }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: true, body: msg.body } };
    const res = await http(`https://graph.facebook.com/${s.apiVersion}/${encodeURIComponent(s.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secrets!.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as { messages?: { id: string }[] };
    return { providerMessageId: json.messages?.[0]?.id };
  },
};

// ---------------------------------------------------------------------------------------------------------
export const emailAdapter: MessageAdapter = {
  channel: 'email',
  async unavailableReason() {
    const s = await getSetting('integrations.email');
    if (!s.enabled) return 'Email is disabled in Settings → Integrations';
    if (!s.host || !s.fromAddress) return 'SMTP host / sender address not configured';
    return null;
  },
  async send(msg) {
    const s = await getSetting('integrations.email');
    const secrets = await getSecrets<{ password: string }>('email');
    const transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: s.username ? { user: s.username, pass: secrets?.password ?? '' } : undefined,
    });
    const dir = msg.language === 'ar' ? 'rtl' : 'ltr';
    const html = `<!doctype html><html dir="${dir}" lang="${msg.language}"><body style="font-family:Arial,sans-serif;background:#FBF7F1;color:#2A1416;padding:24px">
      <div style="max-width:560px;margin:auto;background:#fff;border-top:6px solid #6B1420;padding:24px;border-radius:8px">
      ${escapeHtml(msg.body).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#6B1420">$1</a>')}
      </div></body></html>`;
    const info = await transport.sendMail({
      from: s.fromName ? `"${s.fromName.replace(/"/g, '')}" <${s.fromAddress}>` : s.fromAddress,
      to: msg.to,
      subject: msg.subject ?? '',
      text: msg.body,
      html,
    });
    return { providerMessageId: info.messageId };
  },
};

// ---------------------------------------------------------------------------------------------------------
export const smsAdapter: MessageAdapter = {
  channel: 'sms',
  async unavailableReason() {
    const s = await getSetting('integrations.sms');
    if (!s.enabled) return 'SMS is disabled in Settings → Integrations';
    if (s.provider === 'twilio' && (!s.accountSid || !s.fromNumber)) return 'Twilio account SID / sender not configured';
    if (s.provider === 'generic_http' && !s.url) return 'SMS gateway URL not configured';
    return null;
  },
  async send(msg) {
    const s = await getSetting('integrations.sms');
    const secrets = await getSecrets<{ authToken?: string; apiKey?: string }>('sms');
    if (s.provider === 'twilio') {
      const body = new URLSearchParams({ To: msg.to, From: s.fromNumber, Body: msg.body });
      const res = await http(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.accountSid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${s.accountSid}:${secrets?.authToken ?? ''}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const json = (await res.json()) as { sid?: string };
      return { providerMessageId: json.sid };
    }
    const params = new URLSearchParams({ ...s.extraParams, [s.toParam]: msg.to, [s.textParam]: msg.body });
    if (secrets?.apiKey) params.set('api_key', secrets.apiKey);
    const res =
      s.method === 'GET'
        ? await http(`${s.url}${s.url.includes('?') ? '&' : '?'}${params}`, { method: 'GET' })
        : await http(s.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
    return { providerMessageId: (await res.text()).slice(0, 120) };
  },
};

// ---------------------------------------------------------------------------------------------------------
export const pushAdapter: MessageAdapter = {
  channel: 'push',
  async unavailableReason() {
    return 'Guest push notifications require a configured web-push provider (not part of this release)';
  },
  async send() {
    throw new PermanentSendError('Push channel not configured');
  },
};

export const ADAPTERS: Record<string, MessageAdapter> = {
  whatsapp: whatsappAdapter,
  email: emailAdapter,
  sms: smsAdapter,
  push: pushAdapter,
};
