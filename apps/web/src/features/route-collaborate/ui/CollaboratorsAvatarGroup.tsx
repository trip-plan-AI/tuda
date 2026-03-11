'use client';

import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from '@/shared/ui/avatar';
import { Button } from '@/shared/ui/button';
import { useCollaborateStore } from '../model/collaborate.store';
import { InviteModal } from './InviteModal';

const MAX_VISIBLE = 3;

interface Props {
  tripId: string;
}

export function CollaboratorsAvatarGroup({ tripId }: Props) {
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const { collaborators, onlineUserIds } = useCollaborateStore();

  const onlineCollabs = collaborators.filter((c) => onlineUserIds.includes(c.userId));
  const visible = onlineCollabs.slice(0, MAX_VISIBLE);
  const extra = onlineCollabs.length - MAX_VISIBLE;

  return (
    <div className="flex items-center gap-2">
      {onlineCollabs.length > 0 && (
        <AvatarGroup>
          {visible.map((c) => (
            <Avatar key={c.userId} size="sm" title={c.name}>
              {c.photo ? (
                <AvatarImage src={c.photo} alt={c.name} />
              ) : null}
              <AvatarFallback>{c.name.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
          ))}
          {extra > 0 && (
            <AvatarGroupCount>+{extra}</AvatarGroupCount>
          )}
        </AvatarGroup>
      )}

      <Button
        variant="outline"
        size="icon-xs"
        title="Пригласить участника"
        onClick={() => setIsInviteOpen(true)}
      >
        <UserPlus className="size-3.5" />
      </Button>

      <InviteModal
        tripId={tripId}
        open={isInviteOpen}
        onClose={() => setIsInviteOpen(false)}
      />
    </div>
  );
}
