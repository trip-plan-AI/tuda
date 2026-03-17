import { create } from 'zustand';

interface BudgetStore {
  isExpenseModalOpen: boolean;
  openExpenseModal: () => void;
  closeExpenseModal: () => void;
}

export const useBudgetStore = create<BudgetStore>((set) => ({
  isExpenseModalOpen: false,
  openExpenseModal: () => set({ isExpenseModalOpen: true }),
  closeExpenseModal: () => set({ isExpenseModalOpen: false }),
}));
