export interface PredefinedRoute {
  id: string;
  title: string;
  img: string;
  tags: string[];
  temp: string;
  total: string;
  desc: string;
}

export const PREDEFINED_ROUTES: PredefinedRoute[] = [
  {
    id: 'route-1',
    title: 'Золотое кольцо России',
    img: 'https://images.unsplash.com/photo-1513326212926-6a145e7f47dd?w=800',
    tags: ['Активный', 'История'],
    temp: '-5°C',
    total: '8 дней',
    desc: 'Путешествие по древним городам России, посетите Москву, Владимир, Суздаль и Ростов Великий.',
  },
  {
    id: 'route-2',
    title: 'Карелия: озера и леса',
    img: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800',
    tags: ['Зима', 'Природа'],
    temp: '-10°C',
    total: '5 дней',
    desc: 'Исследуйте красоту озер и лесов Карелии, насладитесь северной природой и северными огнями.',
  },
  {
    id: 'route-3',
    title: 'Путешествие по Кавказу',
    img: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800',
    tags: ['Экстрим', 'Горы'],
    temp: '-8°C',
    total: '10 дней',
    desc: 'Экстремальное путешествие по горам Кавказа, восхождения и невероятные виды гор.',
  },
  {
    id: 'route-4',
    title: 'Байкал: самое глубокое озеро',
    img: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800',
    tags: ['Зима', 'Природа'],
    temp: '-15°C',
    total: '7 дней',
    desc: 'Откройте для себя чудо природы - озеро Байкал, самое глубокое и древнейшее озеро на планете.',
  },
];
