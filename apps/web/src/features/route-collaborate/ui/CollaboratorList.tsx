'use client';

import { useEffect } from 'react';
import { Trash2 } from 'lucide-react';
import { Avatar, AvatarImage, AvatarFallback } from '@/shared/ui/avatar';
import { Button } from '@/shared/ui/button';
import { useUserStore } from '@/entities/user/model/user.store';
import { collaborateApi } from '../api/collaborate.api';
import { useCollaborateStore } from '../model/collaborate.store';

interface Props {
  tripId: string;
  ownerId: string;
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Владелец',
  editor: 'Редактор',
  viewer: 'Наблюдатель',
};

export function CollaboratorList({ tripId, ownerId }: Props) {
  const { collaborators, onlineUserIds, setCollaborators, removeCollaborator } =
    useCollaborateStore();
  const currentUser = useUserStore((s) => s.user);

  useEffect(() => {
    collaborateApi.getAll(tripId).then(setCollaborators).catch(() => {});
  }, [tripId]);

  const isOwner = currentUser?.id === ownerId;

  async function handleRemove(userId: string) {
    try {
      await collaborateApi.remove(tripId, userId);
      removeCollaborator(userId);
    } catch {
      // ignore
    }
  }

  if (collaborators.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-2">Участников пока нет.</p>
    );
  }

  return (
    <ul className="space-y-2">
      {collaborators.map((c) => {
        const isOnline = onlineUserIds.includes(c.userId);
        return (
          <li key={c.userId} className="flex items-center gap-3">
            <div className="relative">
              <Avatar size="sm">
                {c.photo ? (
                  <AvatarImage src={c.photo} alt={c.name} />
                ) : null}
                <AvatarFallback>{c.name.charAt(0).toUpperCase()}</AvatarFallback>
              </Avatar>
              {isOnline && (
                <span className="absolute bottom-0 right-0 size-2 rounded-full bg-green-500 ring-1 ring-background" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{c.name}</p>
              <p className="text-xs text-muted-foreground truncate">{c.email}</p>
            </div>

            <span className="text-xs rounded-full bg-muted px-2 py-0.5 text-muted-foreground shrink-0">
              {ROLE_LABEL[c.role] ?? c.role}
            </span>

            {isOwner && c.userId !== ownerId && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-destructive shrink-0"
                onClick={() => handleRemove(c.userId)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
