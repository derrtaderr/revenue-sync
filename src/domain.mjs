// Domain handling for matching billing and usage records to HubSpot companies. Matching is on
// the exact registrable host after normalisation: eu.northwind.example does not match
// northwind.example (add it to the company's additional domains, or map it explicitly).

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(value) {
  if (typeof value !== 'string') return null;
  let v = value.trim().toLowerCase();
  if (!v || v.includes('@') || /\s/.test(v)) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
  return HOST.test(v) ? v : null;
}

export function emailDomain(email) {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  return at < 0 ? null : normalizeDomain(email.slice(at + 1));
}

// Consumer mail providers. A customer billed at one of these says nothing about their company,
// so it is never domain-matched; map it explicitly instead.
export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'qq.com', '163.com', 'fastmail.com', 'hey.com',
  'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.es', 'yahoo.it', 'yahoo.co.jp', 'yahoo.com.br', 'yahoo.co.in',
  'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it', 'hotmail.es', 'outlook.de', 'outlook.fr', 'live.co.uk',
  'btinternet.com', 'sky.com', 'virginmedia.com', 'orange.fr', 'free.fr', 'laposte.net', 'wanadoo.fr', 'sfr.fr',
  'libero.it', 'virgilio.it', 't-online.de', 'freenet.de', 'mail.ru', 'bk.ru', 'inbox.ru', 'naver.com', 'daum.net',
  'hanmail.net', 'rediffmail.com', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'wp.pl', 'o2.pl', 'interia.pl',
  'onet.pl', 'seznam.cz', '126.com', 'sina.com', 'sohu.com', 'yeah.net', 'tutanota.com', 'pm.me',
]);

export const isFreemail = (domain) => FREEMAIL.has(domain);

// Every domain a HubSpot company answers to: domain, then hs_additional_domains (semicolon
// separated), normalised and de-duplicated.
export function companyDomains(props) {
  const raw = [props?.domain, ...String(props?.hs_additional_domains ?? '').split(';')];
  return [...new Set(raw.map(normalizeDomain).filter(Boolean))];
}
