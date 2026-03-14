'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/shared/ui/dialog';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Avatar, AvatarImage, AvatarFallback } from '@/shared/ui/avatar';
import { collaborateApi, type UserSearchResult } from '../api/collaborate.api';

interface Props {
  tripId: string;
  open: boolean;
  onClose: () => void;
}

export function InviteModal({ tripId, open, onClose }: Props) {
  const [emailInput, setEmailInput] = useState('');
  const [foundUser, setFoundUser] = useState<UserSearchResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  async function handleSearch() {
    if (!emailInput.trim()) return;
    setIsSearching(true);
    setFoundUser(null);
    setSearchError(null);
    try {
      const user = await collaborateApi.searchByEmail(emailInput.trim());
      setFoundUser(user);
    } catch {
      setSearchError('Пользователь не найден');
    } finally {
      setIsSearching(false);
    }
  }

  async function handleInvite() {
    if (!foundUser) return;
    setIsAdding(true);
    try {
      await collaborateApi.sendInvitation(tripId, foundUser.id);
      toast.success(`Приглашение отправлено пользователю ${foundUser.name}`);
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось отправить приглашение';
      setSearchError(message);
      toast.error(message);
    } finally {
      setIsAdding(false);
    }
  }

  function handleClose() {
    setEmailInput('');
    setFoundUser(null);
    setSearchError(null);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Пригласить участника</DialogTitle>
          <DialogDescription>
            Найдите пользователя по email и добавьте его в маршрут.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            placeholder="Email пользователя"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            disabled={isSearching}
          />
          <Button onClick={handleSearch} disabled={isSearching || !emailInput.trim()}>
            {isSearching ? 'Поиск…' : 'Найти'}
          </Button>
        </div>

        {searchError && (
          <p className="text-sm text-red-500">{searchError}</p>
        )}

        {foundUser && (
          <div className="flex items-center gap-3 rounded-lg border border-border p-3">
            <Avatar>
              {foundUser.photo ? (
                <AvatarImage src={foundUser.photo} alt={foundUser.name} />
              ) : null}
              <AvatarFallback>{foundUser.name.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{foundUser.name}</p>
              <p className="text-xs text-muted-foreground truncate">{foundUser.email}</p>
            </div>
            <Button size="sm" onClick={handleInvite} disabled={isAdding}>
              {isAdding ? 'Добавление…' : 'Пригласить'}
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Отмена
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
