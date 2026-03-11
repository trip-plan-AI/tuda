'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { CollaboratorList } from './CollaboratorList';

interface Props {
  tripId: string;
  ownerId: string;
  open: boolean;
  onClose: () => void;
}

export function CollaboratorsModal({ tripId, ownerId, open, onClose }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-brand-indigo font-black text-base">
            Участники маршрута
          </DialogTitle>
        </DialogHeader>
        <CollaboratorList tripId={tripId} ownerId={ownerId} />
      </DialogContent>
    </Dialog>
  );
}
