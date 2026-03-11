import { create } from 'zustand';

export interface Collaborator {
  userId: string;
  name: string;
  email: string;
  photo?: string;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: string;
}

interface CollaborateState {
  collaborators: Collaborator[];
  onlineUserIds: string[];
  isLoading: boolean;
  error: string | null;

  setCollaborators: (list: Collaborator[]) => void;
  addCollaborator: (c: Collaborator) => void;
  removeCollaborator: (userId: string) => void;
  setOnline: (ids: string[]) => void;
  setLoading: (v: boolean) => void;
  setError: (e: string | null) => void;
}

export const useCollaborateStore = create<CollaborateState>()((set) => ({
  collaborators: [],
  onlineUserIds: [],
  isLoading: false,
  error: null,

  setCollaborators: (collaborators) => set({ collaborators }),
  addCollaborator: (c) =>
    set((s) => ({
      collaborators: s.collaborators.some((x) => x.userId === c.userId)
        ? s.collaborators
        : [...s.collaborators, c],
    })),
  removeCollaborator: (userId) =>
    set((s) => ({ collaborators: s.collaborators.filter((c) => c.userId !== userId) })),
  setOnline: (onlineUserIds) => set({ onlineUserIds }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
}));
