import type { Config, JobRunDetailsResponse, RowsResponse, StateResponse } from './types';

export async function getState(signal?: AbortSignal): Promise<StateResponse> {
  const response = await fetch('/api/state', { signal });
  if (!response.ok) throw new Error('Failed to fetch state');
  return (await response.json()) as StateResponse;
}

export async function getRows(
  params: { limit?: number; offset?: number; order?: 'asc' | 'desc'; latestOnly?: boolean },
  signal?: AbortSignal,
) {
  const search = new URLSearchParams();
  if (params.limit != null) search.set('limit', String(params.limit));
  if (params.offset != null) search.set('offset', String(params.offset));
  if (params.order != null) search.set('order', params.order);
  if (params.latestOnly) search.set('latest_only', '1');

  const response = await fetch(`/api/rows?${search.toString()}`, { signal });
  if (!response.ok) throw new Error('Failed to fetch rows');
  return (await response.json()) as RowsResponse;
}

export async function updateConfig(next: Partial<Config>): Promise<StateResponse> {
  const response = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(next),
  });
  if (!response.ok) throw new Error('Failed to update config');
  return (await response.json()) as StateResponse;
}

export async function scan(): Promise<{ created: number }> {
  const response = await fetch('/api/scan', { method: 'POST' });
  if (!response.ok) throw new Error('Failed to scan');
  return (await response.json()) as { created: number };
}

export async function uploadFiles(files: File[]): Promise<{ jobs: unknown[] }> {
  const formData = new FormData();
  for (const file of files) formData.append('files', file, file.name);

  const response = await fetch('/api/upload', { method: 'POST', body: formData });
  if (!response.ok) throw new Error('Upload failed');
  return (await response.json()) as { jobs: unknown[] };
}

export async function rerunJob(jobId: string): Promise<void> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/rerun`, { method: 'POST' });
  if (!response.ok) throw new Error('Failed to rerun job');
}

export async function stopJob(jobId: string): Promise<void> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/stop`, { method: 'POST' });
  if (!response.ok) throw new Error('Failed to stop job');
}

export async function getJobRunDetails(jobId: string, signal?: AbortSignal): Promise<JobRunDetailsResponse> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/run`, { signal });
  if (!response.ok) throw new Error('Failed to fetch run details');
  return (await response.json()) as JobRunDetailsResponse;
}

export async function deleteJob(jobId: string): Promise<void> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete job');
}

