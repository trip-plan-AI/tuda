import type { PoiCategory } from './pipeline.types';

export type PriceSegment = 'free' | 'budget' | 'mid' | 'premium';

export interface PoiItem {
  id: string;
  name: string;
  address: string;
  coordinates: {
    lat: number;
    lon: number;
  };
  category: PoiCategory;
  rating?: number;
  working_hours?: string;
  price_segment?: PriceSegment;
  phone?: string;
  website?: string;
  image_url?: string;
}

export interface FilteredPoiResponse {
  selected: Array<{
    id: string;
    description: string;
  }>;
}

export interface FilteredPoi extends PoiItem {
  description: string;
}
