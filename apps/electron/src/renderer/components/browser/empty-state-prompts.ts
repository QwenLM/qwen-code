import type { BrowserEmptyPromptSample } from '@craft-agent/ui'

export const EMPTY_STATE_PROMPT_SAMPLES: readonly BrowserEmptyPromptSample[] = [
  {
    short: 'HN: summarize top 10 stories in a table',
    full: 'Use the browser to open https://news.ycombinator.com and summarize the top 10 stories in a table with columns: title, source domain, points, comments, and why it matters.',
  },
  {
    short: 'Product Hunt: compare today\'s top 5 launches',
    full: 'Use the browser to go to https://www.producthunt.com, find today\'s top 5 launches, and give me a comparison of product, category, pricing model, and ICP (ideal customer profile).',
  },
  {
    short: 'Observability pricing matrix (DD/New Relic/Grafana)',
    full: 'Use the browser to open https://www.datadoghq.com/pricing, https://newrelic.com/pricing, and https://grafana.com/pricing; build a side-by-side pricing matrix with plan names, monthly cost, free-tier limits, data retention, and overage pricing.',
  },
  {
    short: 'GitHub Docs: latest Actions updates',
    full: 'Use the browser to navigate to https://docs.github.com/en, find the latest updates related to GitHub Actions, and summarize actionable changes for a dev team in under 10 bullets.',
  },
  {
    short: 'UK policy feed: 5 latest announcements',
    full: 'Use the browser to go to https://www.gov.uk/search/news-and-communications and collect the 5 most recent policy announcements, including title, date, department, and one-line summary.',
  },
  {
    short: 'Booking.com: best Budapest stays next weekend',
    full: 'Use the browser to go to https://www.booking.com, search for hotels in Budapest for next weekend, and return the top 10 options sorted by review score with price per night, cancellation policy, and distance from city center.',
  },
  {
    short: 'Kaggle: shortlist 8 churn datasets',
    full: 'Use the browser to open https://www.kaggle.com/datasets, search for customer churn, shortlist 8 high-quality datasets, and rank them by usability for a quick ML prototype.',
  },
  {
    short: 'Status snapshot across GitHub/Cloudflare/Qwen',
    full: 'Use the browser to visit https://www.githubstatus.com, https://www.cloudflarestatus.com, and https://help.aliyun.com/zh/model-studio/; create a concise reliability snapshot with current status, active incidents, and affected components.',
  },
  {
    short: 'Figma Community: trending design systems',
    full: 'Use the browser to go to https://www.figma.com/community, find top trending design system files this week, and summarize which ones are best for SaaS dashboard UI inspiration.',
  },
  {
    short: 'Google Search docs: Core Web Vitals checklist',
    full: 'Use the browser to open https://developers.google.com/search/docs and extract all pages about Core Web Vitals; produce a practical checklist for engineering and SEO teams.',
  },
] as const
