/**
 * Locations API endpoints
 */

import { request, requestFormData } from './client';
import type {
	Location,
	LocationTreeNode,
	LocationCreateRequest,
	LocationUpdateRequest,
} from '../types';

export interface LocationUploadOptions {
	signal?: AbortSignal;
	/** Mark the photo as the location's primary photo */
	primary?: boolean;
}

export const locations = {
	list: (filterChildren?: boolean) => {
		const params = filterChildren !== undefined ? `?filterChildren=${filterChildren}` : '';
		return request<Location[]>(`/locations${params}`);
	},

	tree: () => request<LocationTreeNode[]>('/locations/tree'),

	get: (id: string) => request<Location>(`/locations/${id}`),

	create: (data: LocationCreateRequest) =>
		request<Location>('/locations', {
			method: 'POST',
			body: JSON.stringify(data),
		}),

	uploadAttachment: (
		locationId: string,
		file: File | Blob,
		options: LocationUploadOptions = {}
	) => {
		const formData = new FormData();
		formData.append('file', file, file instanceof File ? file.name : 'image.jpg');
		if (options.primary !== undefined) formData.append('primary', String(options.primary));
		return requestFormData<unknown>(`/locations/${locationId}/attachments`, formData, {
			errorMessage: 'Failed to upload attachment',
			signal: options.signal,
		});
	},

	update: (id: string, data: LocationUpdateRequest) =>
		request<Location>(`/locations/${id}`, {
			method: 'PUT',
			body: JSON.stringify(data),
		}),
};
