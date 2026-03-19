'use client';

import { useState } from 'react';
import { Dialog, DialogContent } from '@/shared/ui/dialog';
import { Button } from '@/shared/ui/button';
import { MapIcon, Mail, Zap, MessageCircle } from 'lucide-react';

export interface Invitation {
  id: string;
  tripId: string;
  tripTitle: string;
  inviterName: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  invitations: Invitation[];
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onOpenInConstructor: (tripId: string) => void;
  onOpenInChat: (tripId: string) => void;
}

export function InvitationsModal({
  open,
  onClose,
  invitations,
  onAccept,
  onDecline,
  onOpenInConstructor,
  onOpenInChat,
}: Props) {
  const [acceptedInvites, setAcceptedInvites] = useState<Set<string>>(new Set());

  const handleAccept = (id: string) => {
    setAcceptedInvites((prev) => new Set([...prev, id]));
    onAccept(id);
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        {/* Enhanced Header */}
        <div className="flex items-center gap-3 pb-4 border-b border-slate-100">
          <div className="w-10 h-10 rounded-full bg-brand-sky/10 flex items-center justify-center shrink-0">
            <Mail size={20} className="text-brand-sky" />
          </div>
          <div>
            <h2 className="text-lg font-black text-brand-indigo">Приглашения в маршруты</h2>
            {invitations.length > 0 && (
              <p className="text-xs text-slate-400 font-medium mt-0.5">
                {invitations.length} новых приглашений
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3 mt-4 max-h-[60vh] overflow-y-auto pr-2
          [&::-webkit-scrollbar]:w-1.5
          [&::-webkit-scrollbar-track]:bg-transparent
          [&::-webkit-scrollbar-thumb]:bg-slate-200
          [&::-webkit-scrollbar-thumb]:rounded-full
          [&::-webkit-scrollbar-thumb:hover]:bg-slate-300">
          {invitations.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-slate-400 py-12">
              <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-3">
                <Mail size={32} className="text-slate-300" />
              </div>
              <p className="text-sm font-semibold text-slate-600">Нет новых приглашений</p>
              <p className="text-xs text-slate-400 mt-1">Когда кто-то вас пригласит, это появится здесь</p>
            </div>
          ) : (
            invitations.map((invite) => (
              <div
                key={invite.id}
                className="p-3 border border-slate-100 rounded-2xl bg-white shadow-sm flex flex-col gap-3"
              >
                <div className="flex gap-3 items-start">
                  <div className="w-10 h-10 rounded-full bg-brand-sky/10 flex items-center justify-center text-brand-sky shrink-0">
                    <MapIcon size={20} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-brand-indigo truncate">
                      {invite.tripTitle}
                    </p>
                    <p className="text-[12px] text-slate-500 mt-0.5 truncate">
                      Приглашает:{' '}
                      <span className="font-semibold text-slate-700">{invite.inviterName}</span>
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  {acceptedInvites.has(invite.id) ? (
                    <>
                      <Button
                        variant="brand"
                        size="sm"
                        className="flex-1 h-8 text-xs font-bold rounded-xl flex items-center justify-center gap-1.5"
                        onClick={() => onOpenInConstructor(invite.tripId)}
                      >
                        <Zap size={14} />
                        В конструктор
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 h-8 text-xs font-bold rounded-xl flex items-center justify-center gap-1.5"
                        onClick={() => onOpenInChat(invite.tripId)}
                      >
                        <MessageCircle size={14} />
                        В чат
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="brand"
                        size="sm"
                        className="flex-1 h-8 text-xs font-bold rounded-xl"
                        onClick={() => handleAccept(invite.id)}
                      >
                        Принять
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 h-8 text-xs font-bold rounded-xl text-red-500 hover:text-red-600 hover:bg-red-50 border-red-100 transition-colors"
                        onClick={() => onDecline(invite.id)}
                      >
                        Отклонить
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
