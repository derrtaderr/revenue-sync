import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain, emailDomain, isFreemail, companyDomains } from '../src/domain.mjs';

test('normalises the ways a domain gets typed into a CRM', () => {
  assert.equal(normalizeDomain('northwind.example'), 'northwind.example');
  assert.equal(normalizeDomain('  NorthWind.Example. '), 'northwind.example');
  assert.equal(normalizeDomain('https://www.northwind.example/pricing?x=1'), 'northwind.example');
  assert.equal(normalizeDomain('http://northwind.example:8080'), 'northwind.example');
  assert.equal(normalizeDomain('www.northwind.example'), 'northwind.example');
});

test('anything that is not a domain is null', () => {
  for (const v of [null, undefined, '', '   ', 'not a domain', 'localhost', 'a@b.example', '-bad.example']) assert.equal(normalizeDomain(v), null, String(v));
});

test('takes the domain from an email address', () => {
  assert.equal(emailDomain('Ann.Lee@Northwind.Example'), 'northwind.example');
  assert.equal(emailDomain('no-at-sign'), null);
  assert.equal(emailDomain(null), null);
});

test('free mail domains are recognised so they never match a company', () => {
  for (const d of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'aol.com']) assert.ok(isFreemail(d), d);
  assert.ok(!isFreemail('northwind.example'));
});

test('a company answers to its primary domain and every additional domain', () => {
  assert.deepEqual(companyDomains({ domain: 'www.northwind.example', hs_additional_domains: 'northwind.io; https://nw.example ;' }), ['northwind.example', 'northwind.io', 'nw.example']);
  assert.deepEqual(companyDomains({ domain: null }), []);
  assert.deepEqual(companyDomains({ domain: 'a.example', hs_additional_domains: 'a.example' }), ['a.example']);
});

test('common non-US free mail domains are refused too (m5)', () => {
  for (const d of ['yahoo.co.uk', 'hotmail.co.uk', 'btinternet.com', 'orange.fr', 'free.fr', 'laposte.net', 'libero.it', 't-online.de', 'mail.ru', 'naver.com', 'yahoo.co.jp', 'rediffmail.com', 'uol.com.br', 'wp.pl', 'seznam.cz', '126.com', 'outlook.de', 'hotmail.fr']) assert.ok(isFreemail(d), d);
});
