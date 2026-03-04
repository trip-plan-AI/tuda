'use client'

import { useState } from 'react'
import { Button } from '@/shared/ui/button'
import type { CreatePointPayload } from '@/entities/route-point'

interface AddPointFormProps {
  onAdd: (payload: CreatePointPayload) => Promise<unknown>
  onCancel: () => void
}

export function AddPointForm({ onAdd, onCancel }: AddPointFormProps) {
  const [title, setTitle] = useState('')
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  const [budget, setBudget] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const latN = parseFloat(lat)
    const lonN = parseFloat(lon)

    if (!title.trim() || isNaN(latN) || isNaN(lonN)) {
      setError('Заполните обязательные поля')
      return
    }

    setLoading(true)
    setError(null)
    try {
      await onAdd({
        title: title.trim(),
        lat: latN,
        lon: lonN,
        budget: budget ? parseInt(budget, 10) : undefined,
      })
      onCancel()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 p-3 bg-white rounded-xl border border-brand-sky/30 shadow-sm"
    >
      <input
        className="w-full text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:border-brand-sky"
        placeholder="Название точки *"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
        autoFocus
      />
      <div className="flex gap-2">
        <input
          className="w-1/2 text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:border-brand-sky"
          placeholder="Широта *"
          type="number"
          step="any"
          value={lat}
          onChange={(e) => setLat(e.target.value)}
          required
        />
        <input
          className="w-1/2 text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:border-brand-sky"
          placeholder="Долгота *"
          type="number"
          step="any"
          value={lon}
          onChange={(e) => setLon(e.target.value)}
          required
        />
      </div>
      <input
        className="w-full text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:border-brand-sky"
        placeholder="Бюджет, ₽ (опционально)"
        type="number"
        min="0"
        value={budget}
        onChange={(e) => setBudget(e.target.value)}
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" className="flex-1" disabled={loading}>
          {loading ? 'Добавляю...' : 'Добавить'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={loading}>
          Отмена
        </Button>
      </div>
    </form>
  )
}
