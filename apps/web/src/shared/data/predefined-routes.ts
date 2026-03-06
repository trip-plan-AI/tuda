export interface PredefinedRoute {
  id: number;
  title: string;
  desc: string;
  total: string;
  img: string;
  tags: string[];
  temp: string;
}

export const PREDEFINED_ROUTES: PredefinedRoute[] = [
  {
    id: 1,
    title: 'Сочи: Горы и Море',
    desc: 'Идеальный баланс: 2 дня в горах, 3 дня на побережье с живописными видами.',
    total: '45 000 ₽',
    img: '/assets/images/sochi.webp',
    tags: ['⚡ Активный', 'РФ'],
    temp: '+15°',
  },
  {
    id: 2,
    title: 'Алтай: Золотые Горы',
    desc: 'Дикая природа, бирюзовая Катунь и бескрайние степи Алтая.',
    total: '55 000 ₽',
    img: '/assets/images/altay.webp',
    tags: ['⚡ Активный', 'РФ'],
    temp: '+8°',
  },
  {
    id: 3,
    title: 'Карелия Winter',
    desc: 'Северные озёра, зимние активности и уютные локации для камерного отдыха.',
    total: '42 500 ₽',
    img: '/assets/images/karelia.webp',
    tags: ['❄️ Зима', 'РФ'],
    temp: '-3°',
  },
  {
    id: 4,
    title: 'Кавказ Peaks',
    desc: 'Высокогорные маршруты и захватывающие виды для любителей эмоций.',
    total: '68 800 ₽',
    img: '/assets/images/kavkaz.webp',
    tags: ['⛰️ Экстрим', 'РФ'],
    temp: '+5°',
  },
];
