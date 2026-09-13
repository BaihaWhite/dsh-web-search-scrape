// SIX-TIER DEPTH LADDER (六档分级检索):
//   The model-facing `web_search` tool is registered by THIS plugin (the
//   built-in tool-web search tool is disabled in the patch) with an optional
//   `tier` argument (1-6). Each tier presets the engine/social quota, result
//   budgets, time budgets, and the verification mode:
//     T1 极速  (~4s)   1 engine, 6 results, no verification
//     T2 快速  (~10s)  2 engines, 10 results, heuristic grading
//     T3 标准  (~20s)  all P0 + 1 social, 20+10 results, heuristic grading
//     T4 增强  (~60s)  all P0 + all P1, 50+80 results, WebSearch subagent triage
//     T5 深度  (~150s) T4 material + subagent opens <=6 pages, upstream checks
//     T6 研究  (~280s) T5 + <=15 pages, multi-round reading, claim verdicts
//   When the model omits `tier`, an auto-tier heuristic picks a FAST default
//   (short factual queries get T1/T2; verification/research keywords escalate
//   to T5/T6). `engines`/`socials` config are POOLS: a tier consumes the
//   first N entries (T1=1 engine, T2=2, T3+=all; T3=1 social, T4+=all).
//   Subagent budgets adapt to `toolBudgetMs`; tiers that cannot fit degrade
//   gracefully with a note in the result (180s tool timeout needs a server
//   restart to take effect).
//
// TIERED SEARCH (分层检索):
//   P0 — general web search engines, searched first;
//   P1 — social platforms, searched second.
//   Each source's title is prefixed with its tier and platform
//   (`[P0·Bing]`, `[P1·微博]`) so the model sees provenance per item.
//
// INFORMATION TRIAGE + MULTI-SOURCE VERIFICATION (消息甄别 + 多源验证):
//   T1 skips verification entirely; T2/T3 use the deterministic heuristic
//   summary (domain reputation grades + similarity clustering). T4-T6 spawn
//   a one-shot **WebSearch subagent** through `ctx.subagents` (`spawn`): the
//   child receives the query plus the scraped sources and executes real LLM
//   triage — per-source credibility into S/A/B/C/D/F bands, multi-source
//   consensus, single-source / contradictory / low-quality flags — and on
//   T5/T6 may open pages via bash+curl to check key claims. It reports back
//   through the scoped `structured_output` tool; the provider folds the
//   structured report into the search result. The child's
//   `web_search`/`subagent`/`subagent_fork` tools are denied (no recursion)
//   and its delegation depth is capped. When the subagent is unavailable,
//   times out, or fails, the provider falls back to the heuristic summary.
//
// Provider id: `web-scrape`. The host `web` row must set
// `searchProvider: web-scrape` (see cordis.patch.yml in this directory).
//
// Plain ESM loaded directly by the dsh profile loader — no build step.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekSearchProvider,
  WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE,
} from '@deepseek-ai/dsh-web-search-deepseek'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  formatSearchOutput,
  presentSearchCall,
  presentSearchResult,
  searchMetaFromValue,
} from '@deepseek-ai/dsh-tool-web'

export const name = 'web-search-scrape'
export const inject = ['web', 'tools', 'systemPrompt']

export const Config = z.object({
  /**
   * Which search backend the `web_search` tool routes to.
   * - `local`    — this plugin's own scrape pipeline (the six-tier ladder below).
   * - `official` — the built-in DeepSeek search provider, reused in-process via
   *                its exported `DeepSeekSearchProvider`; its endpoint / model /
   *                key stay owned by the `web-search-deepseek` settings card.
   * Switching is live: the provider snapshots this on every search.
   */
  backend: z.union([z.const('local'), z.const('official')]).default('local'),
  /** Tier used when `backend: official` (ignored by the local pipeline's own ladder). */
  engines: z.array(z.string()).default(['duckduckgo', 'bing', 'baidu', 'google', 'yandex']),
  socials: z.array(z.string()).default(['weixin', 'bilibili', 'weibo', 'x', 'zhihu', 'douyin', 'reddit']),
  engineResults: z.number().default(50),
  socialResults: z.number().default(80),
  socialPerSite: z.number().default(30),
  verify: z.boolean().default(true),
  subagentVerify: z.boolean().default(true),
  subagentTimeoutMs: z.number().default(120000),
  subagentMaxSources: z.number().default(60),
  /** Scrape-phase deadline when the subagent path is on (leave the child the rest). */
  scrapeTimeoutMs: z.number().default(20000),
  /** The web_search tool layer's enforced timeout; the child budget adapts to it. */
  toolBudgetMs: z.number().default(60000),
  /** Default tier when the model omits `tier`: 0 = auto-heuristic, 1-6 = fixed. */
  defaultTier: z.number().default(0),
  /** Product-controlled result cap, sent as every seam request's maxResults. */
  searchMaxResults: z.number().default(130),
  timeoutMs: z.number().default(20000),
  maxPages: z.number().default(130),
})

export const PROVIDER_ID = 'web-scrape'

// ---- six-tier depth ladder ----------------------------------------------------

/** Per-tier presets. `enginesCount`/`socialsCount` take the first N entries
 *  from the configured pools; budgets and verification mode are tier-owned. */
export const TIERS = {
  1: { label: '极速', enginesCount: 1, socialsCount: 0, engineResults: 6, socialResults: 0, socialPerSite: 0, verify: false, subagentVerify: false, scrapeTimeoutMs: 3000, subagentTimeoutMs: 0, subagentPages: 0, subagentMaxSources: 10 },
  2: { label: '快速', enginesCount: 2, socialsCount: 0, engineResults: 10, socialResults: 0, socialPerSite: 0, verify: true, subagentVerify: false, scrapeTimeoutMs: 8000, subagentTimeoutMs: 0, subagentPages: 0, subagentMaxSources: 12 },
  3: { label: '标准', enginesCount: 99, socialsCount: 1, engineResults: 20, socialResults: 10, socialPerSite: 10, verify: true, subagentVerify: false, scrapeTimeoutMs: 15000, subagentTimeoutMs: 0, subagentPages: 0, subagentMaxSources: 30 },
  4: { label: '增强', enginesCount: 99, socialsCount: 99, engineResults: 50, socialResults: 80, socialPerSite: 30, verify: true, subagentVerify: true, scrapeTimeoutMs: 12000, subagentTimeoutMs: 45000, subagentPages: 0, subagentMaxSources: 60 },
  5: { label: '深度', enginesCount: 99, socialsCount: 99, engineResults: 50, socialResults: 80, socialPerSite: 30, verify: true, subagentVerify: true, scrapeTimeoutMs: 15000, subagentTimeoutMs: 120000, subagentPages: 6, subagentMaxSources: 80 },
  6: { label: '研究', enginesCount: 99, socialsCount: 99, engineResults: 50, socialResults: 80, socialPerSite: 30, verify: true, subagentVerify: true, scrapeTimeoutMs: 25000, subagentTimeoutMs: 240000, subagentPages: 15, subagentMaxSources: 100 },
}

export function clampTier(tier) {
  const number = Number(tier)
  if (!Number.isInteger(number) || number < 1) return undefined
  return Math.min(6, number)
}

/** Keyword-driven auto tier: fast by default, escalate only on explicit
 *  verification/research intent (intent keywords win over length). */
export function autoTier(query) {
  const text = String(query ?? '').trim()
  if (/真的|真假|是否|辟谣|谣言|验证|核实|实锤/u.test(text)) return 5
  if (/报告|综述|调研|白皮书|深度研究/u.test(text)) return 6
  if (/对比|评测|测评|分析|深入|全面|前景|趋势/u.test(text)) return 5
  if (/最新|今天|今日|新闻|发布|上线|版本|价格|涨价/u.test(text)) return 3
  if (/是什么|定义|官网|多少钱|怎么读|怎么拼|缩写|全称/u.test(text)) return 2
  const short = text.length <= 8 && !/[吗么呢吧呀]|[什么|如何|为什么|怎么|哪些|哪个]/u.test(text)
  if (short) return 1
  return 2
}

/** Resolve the effective tier: explicit argument > fixed default > auto. */
export function resolveTier(requestTier, query, defaultTier) {
  const explicit = clampTier(requestTier)
  if (explicit !== undefined) return explicit
  const fixed = clampTier(defaultTier)
  if (fixed !== undefined && fixed >= 1) return fixed
  return autoTier(query)
}

const CURL_BIN = existsSync('/usr/bin/curl') ? '/usr/bin/curl' : 'curl'
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const ACCEPT_HEADERS = {
  'user-agent': USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

// ---- text helpers ----------------------------------------------------------

function safeCodePoint(value) {
  try {
    return String.fromCodePoint(value)
  } catch {
    return ''
  }
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
}

function cleanText(fragment, max = 500) {
  return decodeEntities(String(fragment ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function cleanUrl(url) {
  let cleaned = decodeEntities(String(url ?? '').trim())
  if (cleaned.startsWith('//')) cleaned = `https:${cleaned}`
  if (!/^https?:\/\//i.test(cleaned)) return ''
  const googleMatch = cleaned.match(/^https?:\/\/[^/]+\/url\?q=([^&]+)/i)
  if (googleMatch) {
    try {
      cleaned = decodeURIComponent(googleMatch[1])
    } catch {
      cleaned = googleMatch[1]
    }
  }
  if (!/^https?:\/\//i.test(cleaned)) return ''
  return cleaned
}

/** Extract the real target from a DuckDuckGo `/l/?uddg=<encoded>` link. */
function uddgUrl(href) {
  const match = String(href ?? '').match(/[?&]uddg=([^&"']+)/)
  if (!match) return ''
  let target = match[1]
  try {
    target = decodeURIComponent(target)
  } catch {
    /* keep the raw value */
  }
  return cleanUrl(target)
}

/** Capture group 1 of the first `pattern` match at or after `from`. */
function nextCapture(html, from, pattern) {
  const match = pattern.exec(html.slice(from))
  return match ? match[1] : ''
}

// ---- P0 engines: general web search ----------------------------------------

function parseDdgHtml(html, limit) {
  const results = []
  const pattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  for (const match of html.matchAll(pattern)) {
    const url = uddgUrl(match[1])
    const title = cleanText(match[2], 200)
    if (!url || !title) continue
    const snippet = nextCapture(html, match.index + match[0].length, /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)
    results.push({ url, title, snippet: cleanText(snippet) })
    if (results.length >= limit) break
  }
  return results
}

function parseDdgLite(html, limit) {
  const results = []
  const pattern = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g
  for (const match of html.matchAll(pattern)) {
    const url = cleanUrl(match[1])
    const title = cleanText(match[2], 200)
    if (!url || !title) continue
    const snippet = nextCapture(html, match.index + match[0].length, /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/)
    results.push({ url, title, snippet: cleanText(snippet) })
    if (results.length >= limit) break
  }
  return results
}

function parseBingRss(html, limit) {
  const results = []
  const pattern = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?(?:<description>([\s\S]*?)<\/description>)?[\s\S]*?<\/item>/g
  for (const match of html.matchAll(pattern)) {
    const url = cleanUrl(match[2])
    const title = cleanText(match[1], 200)
    if (!url || !title) continue
    results.push({ url, title, snippet: cleanText(match[3]) })
    if (results.length >= limit) break
  }
  return results
}

function parseBingHtml(html, limit) {
  const results = []
  const pattern = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g
  for (const match of html.matchAll(pattern)) {
    const url = cleanUrl(match[1])
    const title = cleanText(match[2], 200)
    if (!url || !title) continue
    results.push({ url, title, snippet: cleanText(match[3]) })
    if (results.length >= limit) break
  }
  return results
}

function parseBaidu(html, limit) {
  const results = []
  const blocks = html.split(/<div class="result c-container[^"]*"/).slice(1)
  for (const block of blocks) {
    const mu = block.match(/mu="([^"]+)"/)
    let url = mu ? cleanUrl(mu[1]) : ''
    if (!url) {
      const anchor = block.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>/)
      url = anchor ? cleanUrl(anchor[1]) : ''
    }
    const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)
    const title = cleanText(titleMatch ? titleMatch[1] : '', 200)
    if (!url || !title) continue
    let snippet = nextCapture(block, 0, /class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    if (!snippet) snippet = nextCapture(block, 0, /class="content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/)
    results.push({ url, title, snippet: cleanText(snippet) })
    if (results.length >= limit) break
  }
  return results
}

function parseGoogle(html, limit) {
  const results = []
  const pattern = /<a[^>]*href="(\/url\?q=[^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  for (const match of html.matchAll(pattern)) {
    const url = cleanUrl(`https://www.google.com${match[1]}`)
    const title = cleanText(match[2], 200)
    if (!url || !title) continue
    let snippet = nextCapture(html, match.index + match[0].length, /class="VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    if (!snippet) snippet = nextCapture(html, match.index + match[0].length, /class="st"[^>]*>([\s\S]*?)<\/span>/)
    results.push({ url, title, snippet: cleanText(snippet) })
    if (results.length >= limit) break
  }
  return results
}

/** Resolve a Yandex result href: jsredir links carry the real URL base64-encoded in `text=`. */
function yandexUrl(href) {
  const direct = cleanUrl(href)
  if (direct && !/clck\/jsredir|showcaptcha/i.test(direct)) return direct
  const text = String(href ?? '').match(/[?&]text=([^&"']+)/)
  if (!text) return direct
  try {
    let base64 = text[1].replace(/-/g, '+').replace(/_/g, '/')
    while (base64.length % 4) base64 += '='
    const decoded = cleanUrl(Buffer.from(base64, 'base64').toString('utf8'))
    if (decoded) return decoded
  } catch {
    /* fall through to the redirect link */
  }
  return direct
}

function parseYandex(html, limit) {
  const results = []
  const blocks = html.split(/<li class="serp-item[^"]*"/).slice(1)
  for (const block of blocks) {
    let anchor = block.match(/<a[^>]*class="[^"]*organic__url[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!anchor) anchor = block.match(/<h2[^>]*>[\s\S]{0,500}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    const url = yandexUrl(anchor ? anchor[1] : '')
    const title = cleanText(anchor ? anchor[2] : '', 200)
    if (!url || !title) continue
    let snippet = nextCapture(block, 0, /class="organic__content[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    if (!snippet) snippet = nextCapture(block, 0, /class="text-container[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    results.push({ url, title, snippet: cleanText(snippet) })
    if (results.length >= limit) break
  }
  return results
}

export const SCRAPE_ENGINES = {
  duckduckgo: {
    label: 'DuckDuckGo',
    endpoints: (query) => [
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    ],
    parse(html, limit) {
      const results = parseDdgHtml(html, limit)
      return results.length > 0 ? results : parseDdgLite(html, limit)
    },
  },
  bing: {
    label: 'Bing',
    endpoints: (query) => [
      `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=50`,
      `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&count=50`,
    ],
    parse(html, limit) {
      const results = parseBingRss(html, limit)
      return results.length > 0 ? results : parseBingHtml(html, limit)
    },
  },
  baidu: {
    label: 'Baidu',
    // Baidu throttles per IP (百度安全验证); the mobile host is a second
    // chance that shares the same c-container result markup.
    endpoints: (query) => [
      `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=50&ie=utf-8`,
      `https://m.baidu.com/s?wd=${encodeURIComponent(query)}`,
    ],
    parse: parseBaidu,
  },
  google: {
    label: 'Google',
    endpoints: (query) => [`https://www.google.com/search?q=${encodeURIComponent(query)}&num=50&hl=en&gbv=1`],
    parse: parseGoogle,
  },
  yandex: {
    label: 'Yandex',
    // Best effort: datacenter IPs get SmartCaptcha, residential IPs get
    // `li.serp-item` results. Both international and Russian hosts listed.
    endpoints: (query) => [
      `https://yandex.com/search/?text=${encodeURIComponent(query)}`,
      `https://yandex.ru/search/?text=${encodeURIComponent(query)}`,
    ],
    parse: parseYandex,
  },
}

// ---- P1 engines: social platforms ------------------------------------------

function parseBilibili(html, limit) {
  const results = []
  const blocks = html.split(/class="bili-video-card/).slice(1)
  for (const block of blocks) {
    const idMatch = block.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/)
    if (!idMatch) continue
    let title = nextCapture(block, 0, /class="bili-video-card__info--tit"[^>]*title="([^"]+)"/)
    if (!title) title = nextCapture(block, 0, /title="([^"]{4,200}?)"/)
    const clean = cleanText(title, 200)
    if (!clean) continue
    const snippet = nextCapture(block, 0, /class="bili-video-card__info--desc"[^>]*>([\s\S]*?)<\/p>/)
    results.push({ url: `https://www.bilibili.com/video/${idMatch[1]}`, title: clean, snippet: cleanText(snippet) })
    if (results.length >= limit) break
  }
  return results
}

function parseWeibo(html, limit) {
  const results = []
  const blocks = html.split(/class="card-wrap"/).slice(1)
  for (const block of blocks) {
    const link = block.match(/href="(https?:\/\/weibo\.com\/\d+\/[A-Za-z0-9]+)"/)
    if (!link) continue
    const user = block.match(/<a[^>]*class="name"[^>]*>([\s\S]*?)<\/a>/)
    const text = nextCapture(block, 0, /<p[^>]*class="txt"[^>]*>([\s\S]*?)<\/p>/)
    results.push({
      url: cleanUrl(link[1]),
      title: user ? `@${cleanText(user[1], 40)} 的微博` : '微博',
      snippet: cleanText(text),
    })
    if (results.length >= limit) break
  }
  return results
}

function parseX(html, limit) {
  const results = []
  const blocks = html.split(/data-testid="cellInnerDiv"/).slice(1)
  for (const block of blocks) {
    const link = block.match(/href="([^"]*\/status\/\d+)[^"]*"/)
    if (!link) continue
    const text = nextCapture(block, 0, /data-testid="tweetText"[^>]*>([\s\S]*?)<\/div>/)
    const user = block.match(/href="\/([A-Za-z0-9_]{1,15})"/)
    const href = link[1]
    const url = cleanUrl(href.startsWith('/') ? `https://x.com${href}` : href)
    results.push({
      url,
      title: user ? `@${user[1]} 的帖子` : 'X 帖子',
      snippet: cleanText(text),
    })
    if (results.length >= limit) break
  }
  return results
}

function parseZhihu(html, limit) {
  const results = []
  const blocks = html.split(/SearchResult-Card/).slice(1)
  for (const block of blocks) {
    const path = block.match(/\/(?:question\/\d+(?:\/answer\/\d+)?|p\/\d+|zvideo\/\d+)/)
    let title = nextCapture(block, 0, /<h2[^>]*class="ContentItem-title"[^>]*>([\s\S]*?)<\/h2>/)
    if (!title) title = nextCapture(block, 0, /itemprop="name" content="([^"]+)"/)
    const clean = cleanText(title, 200)
    if (!path || !clean) continue
    let snippet = nextCapture(block, 0, /class="RichText[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    if (!snippet) snippet = nextCapture(block, 0, /class="Highlight"[^>]*>([\s\S]*?)<\/em>/)
    results.push({ url: `https://www.zhihu.com${path[0]}`, title: clean, snippet: cleanText(snippet) })
    if (results.length >= limit) break
  }
  return results
}

function parseDouyin(html, limit) {
  const results = []
  const data = html.match(/_ROUTER_DATA\s*=\s*"((?:[^"\\]|\\.)*)"/)
  if (!data) return results
  let decoded = data[1]
  try {
    // unescape the JS string literal, then the URI encoding douyin applies
    decoded = JSON.parse(`"${decoded}"`)
    decoded = decodeURIComponent(decoded)
  } catch {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      /* use the raw value */
    }
  }
  const pattern = /"aweme_id":"(\d+)"[\s\S]{0,800}?"desc":"((?:[^"\\]|\\.)*)"/g
  for (const match of decoded.matchAll(pattern)) {
    let desc = match[2]
    try {
      desc = JSON.parse(`"${desc}"`)
    } catch {
      /* keep the raw escape form */
    }
    const title = cleanText(desc, 80)
    if (!title) continue
    results.push({ url: `https://www.douyin.com/video/${match[1]}`, title, snippet: cleanText(desc, 300) })
    if (results.length >= limit) break
  }
  return results
}

function parseReddit(html, limit) {
  const results = []
  let data
  try {
    data = JSON.parse(html)
  } catch {
    return results
  }
  for (const child of data?.data?.children ?? []) {
    const post = child?.data
    if (!post?.title || !post?.permalink) continue
    const title = post.subreddit ? `r/${post.subreddit} · ${cleanText(post.title, 160)}` : cleanText(post.title, 200)
    results.push({
      url: cleanUrl(`https://www.reddit.com${post.permalink}`),
      title,
      snippet: cleanText(post.selftext || '', 300),
      ...(Number.isFinite(post.created_utc) ? { publishedAt: new Date(post.created_utc * 1000).toISOString() } : {}),
    })
    if (results.length >= limit) break
  }
  return results
}

function parseWeixin(html, limit) {
  const results = []
  const pattern = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>[\s\S]{0,800}?<p[^>]*class="txt-info"[^>]*>([\s\S]*?)<\/p>/g
  for (const match of html.matchAll(pattern)) {
    const href = match[1]
    const url = cleanUrl(href.startsWith('/') ? `https://weixin.sogou.com${href}` : href)
    const title = cleanText(match[2], 200)
    if (!url || !title) continue
    results.push({ url, title, snippet: cleanText(match[3]) })
    if (results.length >= limit) break
  }
  return results
}

export const SOCIAL_ENGINES = {
  bilibili: {
    label: '哔哩哔哩',
    endpoints: (query) => [`https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`],
    parse: parseBilibili,
  },
  weibo: {
    label: '微博',
    endpoints: (query) => [`https://s.weibo.com/weibo?q=${encodeURIComponent(query)}`],
    parse: parseWeibo,
  },
  x: {
    label: 'X',
    endpoints: (query) => [`https://twitter.com/search?q=${encodeURIComponent(query)}&f=top`],
    parse: parseX,
  },
  zhihu: {
    label: '知乎',
    endpoints: (query) => [`https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`],
    parse: parseZhihu,
  },
  douyin: {
    label: '抖音',
    endpoints: (query) => [`https://www.douyin.com/search/${encodeURIComponent(query)}`],
    parse: parseDouyin,
  },
  reddit: {
    label: 'Reddit',
    endpoints: (query) => [`https://old.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=50&raw_json=1`],
    parse: parseReddit,
  },
  weixin: {
    label: '搜狗微信',
    // sogou serves ~10 articles per page; paginate to grow the P1 supply
    endpoints: (query) => [1, 2, 3].map(
      (page) => `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(query)}&page=${page}`,
    ),
    parse: parseWeixin,
  },
}

// ---- transports --------------------------------------------------------------

async function fetchTransport(url, timeoutMs, signal) {
  // undici connect timeouts on bot-hostile hosts burn ~10s each; cap the
  // fetch attempt at 8s so the curl fallback takes over quickly.
  const effective = Math.min(timeoutMs, 8000)
  const timeout = AbortSignal.timeout(effective)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(url, { redirect: 'follow', headers: ACCEPT_HEADERS, signal: combined })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

function curlTransport(url, timeoutMs, signal) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const args = [
    '-sS', '-L', '--compressed', '--max-time', String(seconds),
    '-A', USER_AGENT,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
    '-w', '\n%{http_code}',
    url,
  ]
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    const child = execFile(CURL_BIN, args, { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        settle(reject, new Error(`curl ${error.code ?? 'failed'}: ${String(error.message).split('\n')[0]}`))
        return
      }
      const text = stdout.toString('utf8')
      const cut = text.lastIndexOf('\n')
      const status = Number.parseInt(text.slice(cut + 1).trim(), 10)
      const body = cut >= 0 ? text.slice(0, cut) : text
      if (Number.isFinite(status) && status >= 400) {
        settle(reject, new Error(`HTTP ${status}`))
        return
      }
      settle(resolve, body)
    })
    const onAbort = () => {
      child.kill('SIGKILL')
      settle(reject, abortedError(signal))
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

const TRANSPORTS = [
  { label: 'fetch', run: fetchTransport },
  { label: 'curl', run: curlTransport },
]

// Module-level (process-wide) transport preference: which transport last
// worked for an engine. Survives provider re-registration so warm searches
// never re-pay the fetch-timeout penalty after the first success.
const TRANSPORT_PREFERENCE = new Map()

/** Soft overall deadline for one search: always returns before the tool
 *  layer's own timeout (60s) can kill the call. */
const SEARCH_DEADLINE_MS = 50000

// ---- verification heuristics (消息甄别 + 多源验证) ---------------------------

/** Domain reputation profiles, matched against the URL hostname, first hit wins. */
const DOMAIN_PROFILES = [
  { test: /(^|\.)(gov|edu)(\.[a-z]{2,3})?$/i, level: 'high', label: '政府/教育' },
  {
    test: /(people\.com\.cn|xinhuanet\.com|cctv\.com|chinanews\.com|bbc\.(com|co\.uk)|reuters\.com|apnews\.com|theguardian\.com|nytimes\.com|wsj\.com|ft\.com|economist\.com|caixin\.com|thepaper\.cn|jiemian\.com|nature\.com|science\.org|bloomberg\.com)/i,
    level: 'high',
    label: '权威媒体/期刊',
  },
  { test: /(wikipedia\.org|baike\.baidu\.com|britannica\.com)/i, level: 'high', label: '百科' },
  { test: /(github\.com|gitlab\.com|npmjs\.com|pypi\.org|readthedocs\.io|developer\.[a-z]+\.com)/i, level: 'high', label: '官方代码/文档' },
  { test: /(arxiv\.org|aclanthology\.org|acm\.org|ieee\.org|semanticscholar\.org|doi\.org)/i, level: 'high', label: '学术论文' },
  {
    test: /(36kr\.com|qbitai\.com|ithome\.com|techcrunch\.com|theverge\.com|arstechnica\.com|leiphone\.com|pingwest\.com)/i,
    level: 'medium',
    label: '科技媒体',
  },
  {
    test: /(weibo\.com|weibo\.cn|bilibili\.com|douyin\.com|twitter\.com|x\.com|zhihu\.com|reddit\.com|tieba\.baidu\.com|xiaohongshu\.com|kuaishou\.com|instagram\.com|facebook\.com|youtube\.com|t\.co)/i,
    level: 'low',
    label: '社媒/UGC',
  },
  {
    test: /(zhuanlan\.zhihu\.com|juejin\.cn|csdn\.net|segmentfault\.com|cnblogs\.com|medium\.com|substack\.com|blogspot\.|wordpress\.|lofter\.com|mp\.weixin\.qq\.com)/i,
    level: 'medium',
    label: '自媒体/博客',
  },
  { test: /weixin\.sogou\.com/i, level: 'low', label: '微信聚合(待核实)' },
]

const LEVEL_SCORE = { high: 5, medium: 3, low: 1 }

function classifySource(url) {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return { level: 'medium', label: '未分类站点', score: 2 }
  }
  for (const profile of DOMAIN_PROFILES) {
    if (profile.test.test(host)) return { level: profile.level, label: profile.label, score: LEVEL_SCORE[profile.level] }
  }
  return { level: 'medium', label: '未分类站点', score: 2 }
}

function tokenize(text) {
  const tokens = new Set()
  const words = String(text ?? '').toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
  for (const word of words) tokens.add(word)
  const han = String(text ?? '').replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < han.length; i++) tokens.add(han.slice(i, i + 2))
  return tokens
}

function hanOnly(text) {
  return String(text ?? '').replace(/[^\u4e00-\u9fff]/g, '')
}

function commonPrefixLength(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/** Dice coefficient: forgiving of CJK length variance, robust to dilution. */
function similarity(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const token of a) if (b.has(token)) inter++
  return (2 * inter) / (a.size + b.size)
}

function clusterSources(sources, query) {
  // Query tokens are shared by construction (every item matched the query),
  // so they are noise for corroboration: two items corroborate when they
  // share tokens BEYOND the query itself. A long shared CJK prefix (same
  // headline family) also counts — same-story coverage differs only later.
  const queryTokens = tokenize(query)
  const clusters = []
  for (const source of sources) {
    // strip the tier prefix before tokenizing: it is metadata, not content
    const tokens = tokenize(`${stripPrefix(source.title)} ${source.snippet ?? ''}`)
    const specific = new Set([...tokens].filter((token) => !queryTokens.has(token)))
    const signal = specific.size >= 2 ? specific : tokens
    const han = hanOnly(`${stripPrefix(source.title)} ${source.snippet ?? ''}`)
    let best = null
    let bestScore = 0
    for (const cluster of clusters) {
      const score = similarity(signal, cluster.tokens)
      if (score > bestScore) {
        best = cluster
        bestScore = score
      }
    }
    const prefixJoin =
      best !== null &&
      han.length >= 6 &&
      best.han.length >= 6 &&
      commonPrefixLength(han, best.han) >= 4
    if (best && (bestScore >= 0.25 || prefixJoin)) best.items.push(source)
    else clusters.push({ tokens: signal, han, items: [source] })
  }
  return clusters
}

function distinctDomains(cluster) {
  const set = new Set()
  for (const item of cluster.items) {
    try {
      set.add(new URL(item.url).hostname)
    } catch {
      /* skip unparsable */
    }
  }
  return set.size
}

function stripPrefix(title) {
  return String(title ?? '').replace(/^\[P[01]·[^\]]*\]\s*/, '')
}

/** Build the compact Chinese triage/verification summary carried in `content`. */
export function buildVerification(p0, p1, failures, query) {
  const all = [...p0.sources, ...p1.sources]
  const lines = []
  const p0Line = p0.byEngine.map((entry) => `${entry.label} ${entry.count} 条`).join('、') || '无结果'
  const p1Line =
    p1.sources.length > 0
      ? p1.byEngine.map((entry) => `${entry.label} ${entry.count} 条`).join('、')
      : '无结果（社媒平台普遍反爬，属正常）'
  lines.push(`【分层检索】P0 搜索引擎：${p0Line}；P1 社媒：${p1Line}。`)

  const levels = { high: 0, medium: 0, low: 0 }
  const lowIndexes = []
  all.forEach((source, index) => {
    const verdict = classifySource(source.url)
    levels[verdict.level]++
    if (verdict.level === 'low') lowIndexes.push(index + 1)
  })
  const lowNote =
    lowIndexes.length > 0
      ? `低可信条目序号 ${lowIndexes.slice(0, 12).join('、')}${lowIndexes.length > 12 ? ` 等 ${lowIndexes.length} 条` : ''}，属观点性内容，仅作线索参考。`
      : ''
  lines.push(`【消息甄别】高可信 ${levels.high} 条（政府/教育、权威媒体、百科、官方文档）；中可信 ${levels.medium} 条；低可信 ${levels.low} 条（社媒/UGC）。${lowNote}`)

  const clusters = clusterSources(all, query)
  const corroborated = clusters
    .filter((cluster) => cluster.items.length >= 2 && distinctDomains(cluster) >= 2)
    .sort((a, b) => b.items.length - a.items.length)
  const singles = clusters.filter((cluster) => cluster.items.length === 1).length
  if (corroborated.length > 0) {
    const topics = corroborated
      .slice(0, 5)
      .map((cluster) => {
        const shortest = cluster.items.reduce((min, item) => (item.title.length < min.title.length ? item : min))
        return `「${stripPrefix(shortest.title).slice(0, 40)}」${distinctDomains(cluster)} 站 ${cluster.items.length} 条`
      })
      .join('；')
    lines.push(`【多源验证】${topics} 获多个独立站点佐证。${singles > 0 ? `另有 ${singles} 条仅单源，存疑待核实。` : ''}`)
  } else if (all.length > 0) {
    lines.push(`【多源验证】暂未发现多站一致的证据簇，${singles} 条均为单源，需交叉核实。`)
  }

  if (failures.length > 0) lines.push(`【检索备注】${failures.slice(0, 3).join('；')}`)
  lines.push('（以上为基于域名声誉与多源一致性的启发式评估，非事实核查。）')
  return lines.join('\n')
}

// ---- WebSearch subagent (消息甄别 + 多源验证 by an LLM child agent) ----------

const SUBAGENT_PROVIDER = 'spawn'
const SUBAGENT_LABEL = 'WebSearch'
const SUBAGENT_TOOL_DENY = ['web_search', 'subagent', 'subagent_fork']

/** Tier/count line shared by the subagent report and the heuristic fallback. */
function tierStatsLine(p0, p1) {
  const p0Line = p0.byEngine.map((entry) => `${entry.label} ${entry.count} 条`).join('、') || '无结果'
  const p1Line =
    p1.sources.length > 0
      ? p1.byEngine.map((entry) => `${entry.label} ${entry.count} 条`).join('、')
      : '无结果（社媒平台普遍反爬，属正常）'
  return `【分层检索】P0 搜索引擎：${p0Line}；P1 社媒：${p1Line}。`
}

/** The structured-output schema the WebSearch child must satisfy.
 *  `extended` (T5/T6) adds claim-level verdicts for rumor checking. */
function subagentOutputSchema(extended) {
  const properties = {
    report: { type: 'string' },
    highlights: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    grades: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          band: { type: 'string', enum: ['S', 'A', 'B', 'C', 'D', 'F'] },
          indices: { type: 'array', items: { type: 'number' } },
          note: { type: 'string' },
        },
        required: ['band'],
        additionalProperties: false,
      },
    },
  }
  if (extended) {
    properties.claims = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          verdict: { type: 'string', enum: ['属实', '部分属实', '夸大', '失实', '无法证实'] },
          basis: { type: 'string' },
        },
        required: ['claim', 'verdict'],
        additionalProperties: false,
      },
    }
  }
  return {
    type: 'object',
    properties,
    required: ['report'],
    additionalProperties: false,
  }
}

/** Build the WebSearch child's user prompt from the query and scraped sources. */
function buildSubagentPrompt(query, sources, failures, maxSources, tier) {
  const material = sources
    .slice(0, maxSources ?? 60)
    .map((source, index) => `${index + 1}. ${source.title} | ${source.url} | ${(source.snippet ?? '').slice(0, 120)}`)
    .join('\n')
  const notes = failures.length > 0 ? `\n部分引擎未返回结果：${failures.slice(0, 4).join('；')}。` : ''
  const pages = tier?.subagentPages ?? 0
  const tasks = pages > 0
    ? [
        '任务：',
        '1. 逐条评估可信度：来源性质（官方/权威媒体/百科/自媒体/社媒UGC）、与查询的相关性、是否有营销/情绪化/标题党痕迹。',
        '2. 找出被 ≥2 个独立站点一致支持的核心事实或结论，注明条目序号与站点。',
        '3. 辟谣方法论（重要，禁止一棒子打死）：对每个疑似谣言/夸大的说法，先做最有利解释检查——它是否在更窄口径下成立（最高涨幅 vs 平均涨幅、特定模型 vs 全系、高峰时段 vs 全天、特定指标 vs 整体）？然后给出五级结论之一：属实 / 部分属实（注明成立的条件）/ 夸大（局部真实但被放大或断章取义）/ 失实（无任何依据）/ 无法证实（证据不足）。不得把"口径不同"直接判为失实。',
        `4. 上游来源核查：关键事实必须溯源，优先用 bash 执行 curl 打开官方一手来源核实（官方公告/定价页/官方仓库/权威媒体原文），用一手证据下结论；二手自媒体互相印证不算核实。每条结论注明证据等级：一手官方 / 权威媒体原文 / 二手转载 / 推断。至多打开 ${pages} 个网页；${tier.label === '研究' ? '可多轮阅读并给出完整查证链路。' : ''}不要调用任何搜索或子代理工具。时间预算紧张：优先用 curl+grep 提取关键段落而非下载整页/写复杂脚本；把核实压缩到最关键的页面，先保证结论能提交，来不及核实的项在 concerns 里注明。`,
        '5. 把每条来源归入 S/A/B/C/D/F 六档可信度（S=官方一手；A=权威媒体/百科；B=正规媒体/机构；C=自媒体/博客，交叉验证后可用；D=社媒/UGC 观点，仅线索；F=无法核实、矛盾或营销痕迹重），grades 按档给出条目序号与一句话理由。',
        '6. claims 逐条列出本次核验的主要说法：claim=说法原话；verdict=五级结论之一；basis=一句话证据说明（来源+证据等级）。query 中隐含的说法（如"涨价11倍"）也要核验。',
        '7. 分析完成后，调用 structured_output 工具提交结论。report 用中文写（不超过 500 字，可分段）；highlights 列多源一致的要点；concerns 列存疑、矛盾与低可信条目。',
      ]
    : [
        '任务：',
        '1. 逐条评估可信度：来源性质（官方/权威媒体/百科/自媒体/社媒UGC）、与查询的相关性、是否有营销/情绪化/标题党痕迹。',
        '2. 找出被 ≥2 个独立站点一致支持的核心事实或结论，注明条目序号与站点。',
        '3. 标出仅单源的信息、互相矛盾的说法、可疑或低质内容（注明条目序号）。',
        '4. 不要打开网页，也不要调用任何搜索或子代理工具，只基于给定材料判断。',
        '5. 把每条来源归入 S/A/B/C/D/F 六档可信度（S=官方一手；A=权威媒体/百科；B=正规媒体/机构；C=自媒体/博客，交叉验证后可用；D=社媒/UGC 观点，仅线索；F=无法核实、矛盾或营销痕迹重），grades 按档给出条目序号与一句话理由。',
        '6. 分析完成后，调用 structured_output 工具提交结论。report 用中文写（不超过 500 字，可分段）；highlights 列多源一致的要点；concerns 列存疑、矛盾与低可信条目。',
      ]
  return [
    '你是 WebSearch 子代理，负责对一次网络搜索的原始结果执行消息甄别与多源验证。',
    `查询：「${query}」`,
    `分层检索得到的 ${sources.length} 条来源（标题已带 [层级·平台] 前缀；序号供你引用）：`,
    material,
    notes,
    ...tasks,
  ].join('\n')
}

/** Fold the child's structured report into the search-result content. */
function buildSubagentContent(p0, p1, failures, structured, tierLine) {
  const lines = [tierLine, tierStatsLine(p0, p1)]
  if (structured && typeof structured.report === 'string' && structured.report.trim().length > 0) {
    lines.push(`【WebSearch 子代理甄别】${structured.report.trim()}`)
    if (Array.isArray(structured.highlights) && structured.highlights.length > 0) {
      lines.push(`【多源一致要点】${structured.highlights.map((item) => String(item)).join('；')}`)
    }
    if (Array.isArray(structured.concerns) && structured.concerns.length > 0) {
      lines.push(`【存疑与矛盾】${structured.concerns.map((item) => String(item)).join('；')}`)
    }
    if (Array.isArray(structured.grades) && structured.grades.length > 0) {
      const bands = ['S', 'A', 'B', 'C', 'D', 'F']
      const rows = bands
        .map((band) => {
          const hit = structured.grades.find((entry) => entry && entry.band === band)
          if (!hit) return ''
          const indices = Array.isArray(hit.indices) ? hit.indices.join('、') : ''
          const note = typeof hit.note === 'string' && hit.note.length > 0 ? `（${hit.note}）` : ''
          return `${band}档: ${indices}${note}`
        })
        .filter((row) => row.length > 0)
      if (rows.length > 0) lines.push(`【六档可信度】${rows.join('；')}`)
    }
    if (Array.isArray(structured.claims) && structured.claims.length > 0) {
      const rows = structured.claims
        .filter((entry) => entry && typeof entry.claim === 'string' && typeof entry.verdict === 'string')
        .map((entry) => `「${entry.claim}」→ ${entry.verdict}${typeof entry.basis === 'string' && entry.basis.length > 0 ? `（${entry.basis}）` : ''}`)
      if (rows.length > 0) lines.push(`【说法核验】${rows.join('；')}`)
    }
    lines.push('（甄别报告由 WebSearch 子代理基于检索材料给出，属模型判断，重要结论请以原始来源为准。）')
  }
  if (failures.length > 0) lines.push(`【检索备注】${failures.slice(0, 3).join('；')}`)
  return lines.join('\n')
}

// ---- provider ----------------------------------------------------------------

function abortedError(signal, cause) {
  return new WebError('web scrape search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : cause,
  })
}

function errorMessage(error) {
  const message = String(error?.message ?? error)
  return message.length > 160 ? `${message.slice(0, 160)}…` : message
}

export class ScrapeSearchProvider {
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions
    this.options = resolveOptions()
  }

  id = PROVIDER_ID

  /**
   * Cheap local check only — never touches the network.
   *
   * This provider is the pinned `web.searchProvider`, so it must stay selectable
   * whenever *either* backend could serve a search; availability of the official
   * delegate is therefore part of this answer, not a reason to return false.
   */
  available() {
    this.options = this.resolveOptions()
    if (this.options.backend === 'official') return this.official()?.available() === true
    const { engines, timeoutMs } = this.options
    return Array.isArray(engines) && engines.length > 0 && Number.isFinite(timeoutMs) && timeoutMs > 0
  }

  /** The official DeepSeek provider instance, or `undefined` when unavailable. */
  official() {
    try {
      return this.options.resolveOfficial?.()
    } catch {
      return undefined
    }
  }

  orderTransports(engineName) {
    const preferred = TRANSPORT_PREFERENCE.get(engineName)
    const ordered = preferred
      ? [TRANSPORTS.find((transport) => transport.label === preferred), ...TRANSPORTS.filter((transport) => transport.label !== preferred)]
      : TRANSPORTS
    return ordered.filter(Boolean)
  }

  /** Run one tier: try engines in order until the tier budget is filled or
   *  the search-wide soft deadline passes (return what we have). */
  async runPhase(engineTable, engineNames, query, cap, parseLimit, timeoutMs, tag, seen, signal, failures, deadline) {
    const sources = []
    const labels = []
    const counts = new Map()
    const finish = () => ({ sources, byEngine: labels.map((label) => ({ label, count: counts.get(label) ?? 0 })) })
    if (cap <= 0) return finish()
    for (const engineName of engineNames) {
      if (Date.now() > deadline) return finish()
      const engine = engineTable[engineName]
      if (!engine) continue
      labels.push(engine.label)
      for (const endpoint of engine.endpoints(query)) {
        if (Date.now() > deadline) return finish()
        for (const transport of this.orderTransports(engineName)) {
          if (Date.now() > deadline) return finish()
          if (signal?.aborted === true) throw abortedError(signal)
          this.options.record?.({ query, engine: engineName, endpoint, transport: transport.label, tier: tag })
          let html
          try {
            // clamp the attempt to the remaining budget so an in-flight
            // request can never push the search past the tool timeout
            const attemptTimeout = Math.max(1500, Math.min(timeoutMs, deadline - Date.now()))
            html = await transport.run(endpoint, attemptTimeout, signal)
          } catch (error) {
            if (signal?.aborted === true) throw abortedError(signal, error)
            failures.push(`${engine.label} ${transport.label}: ${errorMessage(error)}`)
            continue
          }
          let items
          try {
            items = engine.parse(html, parseLimit)
          } catch (error) {
            failures.push(`${engine.label} parse: ${errorMessage(error)}`)
            continue
          }
          if (items.length === 0) {
            failures.push(`${engine.label} ${transport.label}: no results parsed`)
            continue
          }
          TRANSPORT_PREFERENCE.set(engineName, transport.label)
          for (const item of items) {
            if (sources.length >= cap) break
            if (!item?.url || !item.title || seen.has(item.url)) continue
            seen.add(item.url)
            counts.set(engine.label, (counts.get(engine.label) ?? 0) + 1)
            sources.push({
              url: item.url,
              title: `[${tag}·${engine.label}] ${item.title}`,
              ...(item.snippet ? { snippet: item.snippet } : {}),
              ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
            })
          }
          if (sources.length >= cap) break
        }
        if (sources.length >= cap) break
      }
      if (sources.length >= cap) break
    }
    return finish()
  }

  async search(request, signal) {
    const query = String(request?.query ?? '').trim()
    if (!query) throw new WebError('web scrape search needs a non-empty query', 'WEB_PROVIDER_ERROR')
    // Snapshot the live settings section for this one search — this is what makes
    // a backend switch in the settings card take effect on the very next call.
    this.options = this.resolveOptions()
    if (this.options.backend === 'official') {
      const official = this.official()
      if (official === undefined) {
        throw new WebError(
          'backend is set to "official" but the DeepSeek search provider is unavailable. ' +
            'Check that DEEPSEEK_API_KEY is present (Settings > Plugins > Plugin configuration > Web search), ' +
            'or switch this plugin\'s backend back to "local".',
          'WEB_PROVIDER_UNAVAILABLE',
        )
      }
      // Delegate in-process: the official card keeps owning endpoint/model/key.
      return await official.search(request, signal)
    }
    const maxResults =
      Number.isInteger(request?.maxResults) && request.maxResults > 0 ? request.maxResults : this.options.maxPages
    // Six-tier ladder: explicit `tier` argument > fixed default > auto-heuristic.
    const tierNumber = resolveTier(request?.tier, query, this.options.defaultTier)
    const tier = TIERS[tierNumber]
    const engines = this.options.engines.slice(0, tier.enginesCount)
    const socials = this.options.socials.slice(0, tier.socialsCount)
    const p0Cap = Math.max(0, Math.min(tier.engineResults, maxResults))
    const p1Cap = Math.max(0, Math.min(tier.socialResults, maxResults - p0Cap))
    const failures = []
    const seen = new Set()
    // Scrape deadline: tier-owned, clamped so the subagent keeps its share.
    const scrapeDeadlineMs = tier.subagentVerify
      ? Math.min(tier.scrapeTimeoutMs, this.options.toolBudgetMs - 20000)
      : Math.min(tier.scrapeTimeoutMs, SEARCH_DEADLINE_MS)
    this.searchStartedAt = Date.now()
    const deadline = this.searchStartedAt + Math.max(3000, scrapeDeadlineMs)

    const p0 = await this.runPhase(
      SCRAPE_ENGINES, engines, query, p0Cap, p0Cap, this.options.timeoutMs, 'P0', seen, signal, failures, deadline,
    )
    // P1 is best-effort: a shorter per-attempt timeout keeps total latency
    // under the tool layer's own search timeout.
    const socialTimeoutMs = Math.min(this.options.timeoutMs, 8000)
    const p1 = await this.runPhase(
      SOCIAL_ENGINES, socials, query, p1Cap, tier.socialPerSite, socialTimeoutMs, 'P1', seen, signal, failures, deadline,
    )

    const sources = [...p0.sources, ...p1.sources]
    if (sources.length === 0) {
      const names = [...engines, ...socials].join(', ')
      const detail = failures.length > 0 ? `: ${failures.slice(0, 6).join('; ')}` : ''
      throw new WebError(`web scrape search failed for every engine (${names})${detail}`, 'WEB_PROVIDER_ERROR')
    }
    let content
    let tierNote = ''
    if (tier.verify && this.options.verify) {
      if (tier.subagentVerify && this.options.subagentVerify) {
        const subagent = await this.verifyWithSubagent(query, tier, tierNumber, p0, p1, failures, signal)
        if (subagent?.content !== undefined) {
          content = subagent.content
          tierNote = subagent.degraded
            ? `【档位】T${tierNumber}·${tier.label}（受工具预算限制降级执行；重启服务器后完整生效）`
            : `【档位】T${tierNumber}·${tier.label}`
        } else if (subagent?.attempted === true) {
          content = `${tierLine(tierNumber, tier)}（子代理甄别未在预算内完成，已回落启发式摘要；重启服务器后完整生效）\n${buildVerification(p0, p1, failures, query)}`
        } else {
          content = `${tierLine(tierNumber, tier)}\n${buildVerification(p0, p1, failures, query)}`
        }
      } else {
        content = `${tierLine(tierNumber, tier)}\n${buildVerification(p0, p1, failures, query)}`
      }
    } else {
      tierNote = tierNumber > 1 ? `【档位】T${tierNumber}·${tier.label}` : ''
    }
    const finalContent =
      content !== undefined
        ? content
        : tierNote.length > 0
          ? `${tierNote}\n${tierStatsLine(p0, p1)}`
          : undefined
    return {
      ...(finalContent !== undefined ? { content: finalContent } : {}),
      sources,
      truncated: false,
    }
  }

  /** Spawn the WebSearch subagent for LLM triage. Returns {content, degraded}
   *  on a completed structured report, {attempted: true} when the child was
   *  spawned but produced no usable structured result (cancelled/failed), or
   *  undefined when no spawn was attempted (caller falls back silently). */
  async verifyWithSubagent(query, tier, tierNumber, p0, p1, failures, signal) {
    if (tier.subagentVerify !== true) return undefined
    const parent = this.options.resolveParent?.()
    if (parent === undefined || this.options.startSubagent === undefined) return undefined
    const sources = [...p0.sources, ...p1.sources]
    if (sources.length === 0) return undefined
    try {
      // Adaptive child budget: the tier's subagent allowance, clamped by
      // whatever the tool layer actually enforces minus elapsed minus margin.
      const elapsed = Date.now() - (this.searchStartedAt ?? Date.now())
      const allowed = Math.max(15000, this.options.toolBudgetMs - elapsed - 4000)
      const childBudget = Math.min(tier.subagentTimeoutMs, allowed)
      const degraded = childBudget < tier.subagentTimeoutMs * 0.8
      const timeoutSignal = AbortSignal.timeout(childBudget)
      const childSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
      this.options.record?.({ query, action: 'websearch-subagent-spawn', provider: SUBAGENT_PROVIDER, tier: tierNumber })
      const run = await this.options.startSubagent({
        label: SUBAGENT_LABEL,
        prompt: [{ type: 'text', text: buildSubagentPrompt(query, sources, failures, tier.subagentMaxSources, tier) }],
        parent,
        signal: childSignal,
        outputSchema: subagentOutputSchema(tier.subagentPages > 0),
        maxDepth: (delegationDepthOf(parent) ?? 0) + 1,
        toolFilter: { deny: SUBAGENT_TOOL_DENY },
      })
      if (run === undefined) return undefined
      try {
        const result = await run.result
        this.options.record?.({ query, action: 'websearch-subagent-end', stopReason: result?.stopReason, tier: tierNumber })
        if (result?.stopReason === 'completed' && result.structured !== undefined && result.structured !== null) {
          const line = tierLine(tierNumber, tier) + (degraded ? '（受工具预算限制降级执行；重启服务器后完整生效）' : '')
          return {
            content: buildSubagentContent(p0, p1, failures, result.structured, line),
            degraded,
          }
        }
        return { attempted: true }
      } finally {
        run.dispose?.()
      }
    } catch (error) {
      this.options.record?.({ query, action: 'websearch-subagent-failed', error: errorMessage(error), tier: tierNumber })
      return { attempted: true }
    }
  }
}

/** One-line tier banner used in verification content. */
function tierLine(tierNumber, tier) {
  return `【档位】T${tierNumber}·${tier.label}`
}

// ---- plugin entry ------------------------------------------------------------

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function normalizeList(raw, table, fallback) {
  const list = []
  const seen = new Set()
  for (const name of Array.isArray(raw) ? raw : []) {
    const key = String(name).toLowerCase()
    if (seen.has(key) || !table[key]) continue
    seen.add(key)
    list.push(key)
  }
  return list.length > 0 ? list : fallback
}

/** Settings namespace of this plugin. A plain lowercase-hyphenated string:
 *  DSH 0.1.5-rc.2 no longer ships the `settingsNamespace()` brand helper. */
export const WEB_SCRAPE_SETTINGS_NAMESPACE = 'web-search-scrape'

/** Environment variable naming the official provider's endpoint (its own, distinct
 *  from `$DEEPSEEK_BASE_URL` which belongs to the chat-completions adapter). */
const DEEPSEEK_SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'
const DEFAULT_DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/**
 * Bridge to the built-in DeepSeek search provider so `backend: official` can reuse
 * it *in-process* instead of re-implementing its HTTP call.
 *
 * `@deepseek-ai/dsh-web-search-deepseek` exports both `DeepSeekSearchProvider` and
 * its settings namespace, but not its private `resolveOptions`. We therefore read
 * the official section through the settings service (so the official "Web search"
 * card stays the single owner of endpoint/model/key) and project it into the same
 * option shape the official plugin builds.
 *
 * Returns `undefined` when the official package or its section is unavailable, so
 * the caller can report a precise error instead of failing at import time.
 */
function createOfficialBridge(ctx) {
  let provider
  return () => {
    if (provider !== undefined) return provider
    const settings = ctx.get('settings')
    const section = settings?.get?.(WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE)
    const config = section ?? {}
    const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_DEEPSEEK_API_KEY_ENV)
    const literalApiKey = typeof config.apiKey === 'string' && config.apiKey.length > 0 ? config.apiKey : undefined
    provider = new DeepSeekSearchProvider(() => ({
      ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
      resolveApiKey: async () => {
        const credentials = ctx.get('credentials')
        if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
        const ambient = process.env[apiKeyEnv]
        return ambient !== undefined && ambient.length > 0 ? ambient : undefined
      },
      apiKeyEnv,
      baseURL: config.baseURL ?? process.env[DEEPSEEK_SEARCH_BASE_URL_ENV] ?? DEEPSEEK_DEFAULT_BASE_URL,
      model: config.model ?? DEEPSEEK_DEFAULT_MODEL,
      apiVersion: config.apiVersion ?? DEEPSEEK_DEFAULT_API_VERSION,
      maxTokens: config.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS,
      maxUses: config.maxUses ?? DEEPSEEK_DEFAULT_MAX_USES,
      recordRequest: (request) => {
        ctx.get('agents')?.currentInitiator?.()?.session.append('web/deepseek-search-llm-request', request)
      },
    }))
    return provider
  }
}

export function apply(ctx, config) {
  // The settings section is the live source: the Plugins-page card edits it and
  // every search snapshots the current section through resolveOptions.
  //
  // `setSource` hands over a *thunk* (`() => T`), not a value — keep it as one and
  // call it at each read, or card edits would never reach resolveOptions.
  let readSection = () => config
  let reRegisterTool = () => {}
  const resolveOfficial = createOfficialBridge(ctx)
  // `installSection` lives on the `settings` service (0.1.5-rc.2); the owner stays
  // this plugin's context so the section is uninstalled with this fiber.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, WEB_SCRAPE_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        readSection = source
      },
      onChange: () => {
        // tool timeout lives on the registered ToolDefinition — re-register so
        // a card edit of toolBudgetMs (or backend) takes effect immediately.
        reRegisterTool()
      },
    })
  })

  const staticThunks = {
    resolveParent: () => {
      try {
        return ctx.get('agents')?.currentInitiator?.()
      } catch {
        return undefined
      }
    },
    startSubagent: async (request) => {
      const subagents = ctx.get('subagents')
      if (subagents === undefined) return undefined
      return await subagents.start(SUBAGENT_PROVIDER, request)
    },
    record: (payload) => {
      /* telemetry only — custom session event types are not part of the
         harness vocabulary and would poison the durable log (the persistence
         layer refuses logs containing unknown, non-ignorable event types) */
    },
  }

  const resolveOptions = () => {
    const section = readSection() ?? {}
    return {
      backend: section.backend === 'official' ? 'official' : 'local',
      resolveOfficial,
      engines: normalizeList(section.engines, SCRAPE_ENGINES, ['duckduckgo', 'bing', 'baidu', 'google', 'yandex']),
      socials: normalizeList(section.socials, SOCIAL_ENGINES, ['weixin', 'bilibili', 'weibo', 'x', 'zhihu', 'douyin', 'reddit']),
      verify: section.verify !== false,
      subagentVerify: section.subagentVerify !== false,
      toolBudgetMs: clamp(section.toolBudgetMs, 30000, 600000, 60000),
      defaultTier: clamp(section.defaultTier, 0, 6, 0),
      searchMaxResults: clamp(section.searchMaxResults, 1, 200, 130),
      timeoutMs: clamp(section.timeoutMs, 1000, 120000, 20000),
      maxPages: clamp(section.maxPages, 1, 200, 130),
      ...staticThunks,
    }
  }

  ctx.web.registerSearchProvider(new ScrapeSearchProvider(resolveOptions))
  installWebSearchTool(ctx, resolveOptions, (wire) => {
    reRegisterTool = wire
  })
}

/** Register the model-facing `web_search` tool (the built-in tool-web search
 *  tool is disabled in the patch) with the tier argument, reusing tool-web's
 *  presentation so the GUI web card keeps rendering. */
function installWebSearchTool(ctx, resolveOptions, wire) {
  const section = () => resolveOptions()
  const define = () =>
    defineTool({
      name: 'web_search',
      description:
        'Search the web for current information with selectable depth. Returns an optional summary answer and a list of source URLs. ' +
        'Tier guide: 1 极速 (one engine, ~4s) · 2 快速 (~10s) · 3 标准 (all engines + WeChat, ~20s) · 4 增强 (tiered P0/P1 + LLM subagent triage, ~60s) · 5 深度 (+ subagent opens pages and checks upstream sources, ~150s) · 6 研究 (multi-round deep research with claim verdicts, ~280s).',
      parameters: {
        query: { type: 'string', required: true, description: 'The search query.' },
        tier: {
          type: 'number',
          description:
            'Optional depth tier 1-6 (default: auto). 1-2 for simple facts, 3 for general lookups, 4 for judging source reliability, 5 to verify claims or rumors, 6 for comprehensive research.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string' },
            sources: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  url: { type: 'string', required: true },
                  title: { type: 'string' },
                  snippet: { type: 'string' },
                  publishedAt: { type: 'string' },
                },
              },
            },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: formatSearchOutput(value) }],
        presentationMeta: (_args, value) => searchMetaFromValue(value),
      },
      timeoutMs: section().toolBudgetMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const query = String(args.query ?? '').trim()
        if (!query) throw new Error('query must be a non-empty string')
        const tier = clampTier(args.tier)
        const result = await ctx.web.search(
          {
            query,
            maxResults: section().searchMaxResults,
            ...(tier !== undefined ? { tier } : {}),
          },
          exec.signal,
        )
        return {
          ...(result.content !== undefined ? { content: result.content } : {}),
          sources: result.sources.map((source) => ({
            url: source.url,
            ...(source.title !== undefined ? { title: source.title } : {}),
            ...(source.snippet !== undefined ? { snippet: source.snippet } : {}),
            ...(source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {}),
          })),
          truncated: result.truncated,
        }
      },
      presentCall: (args) => presentSearchCall(args),
      presentResult: (args, result) => presentSearchResult(args, result),
    })

  const disposers = []
  const register = () => disposers.push(ctx.tools.register(define()))
  ctx.effect(() => () => {
    disposers.splice(0).forEach((dispose) => dispose())
  })
  register()
  wire(() => {
    disposers.splice(0).forEach((dispose) => dispose())
    register()
  })

  ctx.systemPrompt.section({
    name: 'tool:web_search',
    order: 110,
    text: [
      'Use the web_search tool to discover current information on the web. It returns an optional answer plus a list of source URLs.',
      'The optional `tier` argument selects the depth (auto-selected when omitted):',
      '  1 极速: one engine, quick fact (~4s) · 2 快速: two engines (~10s) · 3 标准: all engines + WeChat (~20s)',
      '  4 增强: tiered P0/P1 search with an LLM subagent triage report (~60s) · 5 深度: the subagent also opens pages and checks upstream sources (~150s) · 6 研究: multi-round deep research with claim verdicts (~280s).',
      'Prefer tier 1-2 for simple facts, 3 for general lookups, 4 when judging source reliability matters, 5 to verify claims or rumors, 6 for comprehensive research reports.',
      'Use the returned source snippets when available, and cite the relevant URLs as markdown links.',
    ].join('\n'),
  })
}

export default { name, inject, Config, apply }
