import { api } from '@/shared/api/http';

export interface Collaborator {
  userId: string;
  name: string;
  email: string;
  photo?: string;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: string;
}

export interface UserSearchResult {
  id: string;
  name: string;
  email: string;
  photo?: string;
}

export const collaborateApi = {
  getAll: (tripId: string): Promise<Collaborator[]> =>
    api.get(`/trips/${tripId}/collaborators`),

  add: (
    tripId: string,
    userId: string,
    role: 'editor' | 'viewer' = 'editor',
  ): Promise<Collaborator> =>
    api.post(`/trips/${tripId}/collaborators`, { userId, role }),

  remove: (tripId: string, userId: string): Promise<{ removed: boolean }> =>
    api.del(`/trips/${tripId}/collaborators/${userId}`),

  searchByEmail: (email: string): Promise<UserSearchResult> =>
    api.get(`/users/search?email=${encodeURIComponent(email)}`),

  // ── Invitations ──
  sendInvitation: (tripId: string, userId: string): Promise<{ id: string }> =>
    api.post(`/trips/${tripId}/invitations`, { userId }),

  acceptInvitation: (invitationId: string): Promise<{ accepted: boolean; trip: any }> =>
    api.post(`/invitations/${invitationId}/accept`, {}),

  declineInvitation: (invitationId: string): Promise<{ declined: boolean }> =>
    api.del(`/invitations/${invitationId}`),
};
