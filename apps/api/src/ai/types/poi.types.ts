import type { PoiCategory } from './pipeline.types';

export type PriceSegment = 'free' | 'budget' | 'mid' | 'premium';

export interface PoiItem {
  id: string;
  name: string;
  address: string;
  logical_id?: string;
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
  ai_generated?: boolean; // TRI-108-6: Mark AI-generated food POIs
}

export interface FilteredPoiResponse {
  selected: Array<{
    id: string;
    description: string;
  }>;
}

export interface LlmGeneratedPoiResponse {
  selected: Array<{
    id: string;
    name: string;
    category: PoiCategory;
    rating?: number;
    description: string;
  }>;
}

export interface FilteredPoi extends PoiItem {
  description: string;
}
