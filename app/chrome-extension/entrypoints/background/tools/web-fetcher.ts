/* eslint-disable @typescript-eslint/no-explicit-any */
// Tooling for interacting with the active tab in the Chrome extension background service worker.

/**
 * The Chrome namespace is provided by the runtime environment. Typings may not be
 * available during unit tests, so we declare the minimal surface that we rely on.
 */
declare const chrome: any;

export interface JobScraperSelectors {
  /** Selector for the container node that wraps a single job card. */
  jobCard: string;
  /** Selector for the job title within the job card. */
  title: string;
  /** Selector for the company label within the job card. */
  company: string;
  /** Selector for the location label within the job card. */
  location?: string;
  /** Selector for the anchor element linking to the job. */
  link?: string;
  /** Selector that will match metadata nodes such as employment type or seniority. */
  metadata?: string;
}

export interface ExtractLinkedInJobsTask {
  type: 'extractLinkedInJobs';
  /** Optional overrides that allow callers to tweak selectors for experiments. */
  overrideSelectors?: Partial<JobScraperSelectors>;
}

export interface GetFullPageHTMLTask {
  type: 'getFullPageHTML';
}

export type WebFetcherTask = ExtractLinkedInJobsTask | GetFullPageHTMLTask;

export interface LinkedInJob {
  title: string;
  company: string;
  location: string;
  jobLink: string;
  metadata: string[];
}

interface InjectedJobScraperArgs {
  defaultSelectors: JobScraperSelectors;
  overrideSelectors?: Partial<JobScraperSelectors> | null;
}

const DEFAULT_LINKEDIN_SELECTORS: JobScraperSelectors = {
  jobCard: 'li.jobs-search-results__list-item',
  title: 'a.job-card-list__title',
  company: 'span.job-card-container__primary-description',
  location: 'span.job-card-container__metadata-item',
  link: 'a.job-card-list__title',
  metadata: 'span.job-card-container__metadata-item',
};

const injectedJobScraper = ({
  defaultSelectors,
  overrideSelectors,
}: InjectedJobScraperArgs): LinkedInJob[] => {
  const selectors = Object.assign({}, defaultSelectors, overrideSelectors ?? {});

  const normalizeText = (value?: string | null): string =>
    (value ?? '')
      .replace(/\s+/g, ' ')
      .trim();

  const toAbsoluteUrl = (rawUrl: string | null | undefined): string => {
    const candidate = normalizeText(rawUrl ?? '');
    if (!candidate) return '';

    try {
      const url = new URL(candidate, window.location.href);
      return url.toString();
    } catch (error) {
      console.warn('[web-fetcher] Failed to normalize job link', error);
      return candidate;
    }
  };

  const jobNodes = Array.from(
    document.querySelectorAll<HTMLElement>(selectors.jobCard),
  );

  return jobNodes
    .map((node) => {
      const titleElement = selectors.title
        ? node.querySelector<HTMLElement>(selectors.title)
        : null;
      const companyElement = selectors.company
        ? node.querySelector<HTMLElement>(selectors.company)
        : null;
      const locationElement = selectors.location
        ? node.querySelector<HTMLElement>(selectors.location)
        : null;
      const linkElement = selectors.link
        ? node.querySelector<HTMLAnchorElement>(selectors.link)
        : node.querySelector<HTMLAnchorElement>('a');

      const metadataElements = selectors.metadata
        ? Array.from(node.querySelectorAll<HTMLElement>(selectors.metadata))
        : [];

      const metadata = metadataElements
        .map((element) => normalizeText(element?.textContent))
        .filter((value) => Boolean(value));

      const location = normalizeText(locationElement?.textContent) || metadata[0] || '';
      const filteredMetadata = locationElement ? metadata : metadata.slice(1);

      const normalizedJob: LinkedInJob = {
        title: normalizeText(titleElement?.textContent),
        company: normalizeText(companyElement?.textContent),
        location,
        jobLink: toAbsoluteUrl(linkElement?.getAttribute('href')),
        metadata: filteredMetadata,
      };

      if (!normalizedJob.title && !normalizedJob.company && !normalizedJob.jobLink) {
        return null;
      }

      return normalizedJob;
    })
    .filter((job): job is LinkedInJob => Boolean(job));
};

const getFullPageHTMLInjection = (): string => {
  const documentElement = document.documentElement;
  if (documentElement?.outerHTML) {
    return documentElement.outerHTML;
  }

  const body = document.body;
  return body?.innerHTML ?? '';
};

const ensureActiveTabId = async (): Promise<number> => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const [activeTab] = tabs as Array<{ id?: number }>;
  if (!activeTab?.id) {
    throw new Error('Unable to locate an active tab for the requested web fetcher task.');
  }

  return activeTab.id;
};

const runExtractLinkedInJobsTask = async (
  task: ExtractLinkedInJobsTask,
): Promise<LinkedInJob[]> => {
  const tabId = await ensureActiveTabId();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: injectedJobScraper,
    args: [
      {
        defaultSelectors: DEFAULT_LINKEDIN_SELECTORS,
        overrideSelectors: task.overrideSelectors ?? null,
      },
    ],
  });

  return (results?.[0]?.result as LinkedInJob[]) ?? [];
};

const runGetFullPageHTMLTask = async (): Promise<string> => {
  const tabId = await ensureActiveTabId();
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: getFullPageHTMLInjection,
  });

  return (results?.[0]?.result as string) ?? '';
};

const taskHandlers: Record<WebFetcherTask['type'], (task: WebFetcherTask) => Promise<unknown>> = {
  extractLinkedInJobs: runExtractLinkedInJobsTask as (
    task: WebFetcherTask,
  ) => Promise<LinkedInJob[]>,
  getFullPageHTML: runGetFullPageHTMLTask as (task: WebFetcherTask) => Promise<string>,
};

export const runWebFetcherTask = async <TTask extends WebFetcherTask>(
  task: TTask,
): Promise<TTask extends ExtractLinkedInJobsTask ? LinkedInJob[] : string> => {
  const handler = taskHandlers[task.type];
  if (!handler) {
    throw new Error(`Unsupported web fetcher task: ${task.type}`);
  }

  const result = await handler(task);
  return result as TTask extends ExtractLinkedInJobsTask ? LinkedInJob[] : string;
};

export type ExtractLinkedInJobsResult = LinkedInJob[];
export type GetFullPageHTMLResult = string;
