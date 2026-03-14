'use client';

import { useState } from 'react';
import { Mail, LogOut, Settings, User } from 'lucide-react';
import { InvitationsModal } from '@/features/route-collaborate/ui/InvitationsModal';
import { getEmailPrefix } from '@/shared/lib/formatters';

interface UserDropdownProps {
  userName?: string;
  userEmail?: string;
  userAvatar?: string;
  invitations?: Array<{
    id: string;
    tripId: string;
    tripTitle: string;
    inviterName: string;
  }>;
  onAccept?: (id: string) => void;
  onDecline?: (id: string) => void;
  onLogout?: () => void;
  onSettings?: () => void;
}

export function UserDropdown({
  userName = 'User',
  userEmail = 'user@example.com',
  userAvatar,
  invitations = [],
  onAccept,
  onDecline,
  onLogout,
  onSettings,
}: UserDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isInvitationsOpen, setIsInvitationsOpen] = useState(false);

  const initials = userName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <>
      {/* Dropdown trigger */}
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-slate-100 transition-colors shrink-0"
        >
          {userAvatar ? (
            <img
              src={userAvatar}
              alt={userName}
              className="w-8 h-8 rounded-full object-cover border border-slate-200"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-brand-indigo/10 flex items-center justify-center text-[11px] font-bold text-brand-indigo border border-slate-200">
              {initials}
            </div>
          )}
          <div className="hidden sm:flex flex-col items-start">
            <p className="text-sm font-semibold text-slate-900 leading-none">{userName}</p>
            <p className="text-[11px] text-slate-400">{getEmailPrefix(userEmail)}</p>
          </div>
        </button>

        {/* Dropdown menu */}
        {isOpen && (
          <div className="absolute top-full right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-slate-100 overflow-hidden z-50">
            {/* User info */}
            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
              <p className="text-sm font-semibold text-slate-900">{userName}</p>
              <p className="text-xs text-slate-500 mt-0.5">{userEmail}</p>
            </div>

            {/* Menu items */}
            <div className="py-1">
              {/* Invitations */}
              <button
                onClick={() => {
                  setIsOpen(false);
                  setIsInvitationsOpen(true);
                }}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <Mail size={16} className="text-slate-400" />
                Приглашения
                {invitations.length > 0 && (
                  <span className="ml-auto bg-brand-sky text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                    {invitations.length}
                  </span>
                )}
              </button>

              {/* Profile */}
              <button
                onClick={() => {
                  setIsOpen(false);
                  // TODO: navigate to profile
                }}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <User size={16} className="text-slate-400" />
                Личный кабинет
              </button>

              {/* Settings */}
              <button
                onClick={() => {
                  setIsOpen(false);
                  onSettings?.();
                }}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <Settings size={16} className="text-slate-400" />
                Настройки
              </button>
            </div>

            {/* Logout */}
            <div className="py-1 border-t border-slate-100">
              <button
                onClick={() => {
                  setIsOpen(false);
                  onLogout?.();
                }}
                className="flex items-center gap-3 w-full px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50 transition-colors"
              >
                <LogOut size={16} />
                Выход
              </button>
            </div>
          </div>
        )}

        {/* Click outside to close */}
        {isOpen && (
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
        )}
      </div>

      {/* Invitations Modal */}
      <InvitationsModal
        open={isInvitationsOpen}
        onClose={() => setIsInvitationsOpen(false)}
        invitations={invitations}
        onAccept={(id) => {
          onAccept?.(id);
          // Remove from list after accepting
          // setInvitations(prev => prev.filter(i => i.id !== id))
        }}
        onDecline={(id) => {
          onDecline?.(id);
          // Remove from list after declining
          // setInvitations(prev => prev.filter(i => i.id !== id))
        }}
      />
    </>
  );
}
