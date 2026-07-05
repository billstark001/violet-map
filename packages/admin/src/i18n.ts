import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const resources = {
  en: {
    translation: {
      title: 'Violet Map Admin',
      worlds: 'Worlds',
      upload: 'Upload',
      biomes: 'Biomes',
      refresh: 'Refresh',
      world: 'World',
      dimension: 'Dimension',
      regions: 'Region files',
      noWorlds: 'No worlds found. Upload data to get started.',
      createWorld: 'Create empty world',
      worldName: 'World name',
      levelName: 'Level name',
      delete: 'Delete',
      uploadChunkData: 'Upload Chunk Data',
      uploadHelp: 'Supports .mca region files or individual chunk NBT files with xPos/zPos.',
      uploading: 'Uploading...',
      save: 'Save',
      saved: 'Saved. Reload the viewer to apply changes.',
      token: 'Admin token',
      language: 'Language',
      missingFile: 'Choose a file first.',
      uploadFailed: 'Upload failed',
      biomeTitle: 'Biome Color Data',
    },
  },
  'zh-CN': {
    translation: {
      title: 'Violet Map 管理台',
      worlds: '世界',
      upload: '上传',
      biomes: '群系',
      refresh: '刷新',
      world: '世界',
      dimension: '维度',
      regions: '区域文件',
      noWorlds: '没有找到世界。上传数据后即可开始。',
      createWorld: '创建空世界',
      worldName: '世界名称',
      levelName: '存档名称',
      delete: '删除',
      uploadChunkData: '上传区块数据',
      uploadHelp: '支持 .mca 区域文件，或带 xPos/zPos 的单区块 NBT 文件。',
      uploading: '上传中...',
      save: '保存',
      saved: '已保存。重新加载 viewer 后生效。',
      token: '管理 token',
      language: '语言',
      missingFile: '请先选择文件。',
      uploadFailed: '上传失败',
      biomeTitle: '群系颜色数据',
    },
  },
  'zh-TW': {
    translation: {
      title: 'Violet Map 管理台',
      worlds: '世界',
      upload: '上傳',
      biomes: '群系',
      refresh: '重新整理',
      world: '世界',
      dimension: '維度',
      regions: '區域檔案',
      noWorlds: '沒有找到世界。上傳資料後即可開始。',
      createWorld: '建立空世界',
      worldName: '世界名稱',
      levelName: '存檔名稱',
      delete: '刪除',
      uploadChunkData: '上傳區塊資料',
      uploadHelp: '支援 .mca 區域檔案，或帶 xPos/zPos 的單區塊 NBT 檔案。',
      uploading: '上傳中...',
      save: '儲存',
      saved: '已儲存。重新載入 viewer 後生效。',
      token: '管理 token',
      language: '語言',
      missingFile: '請先選擇檔案。',
      uploadFailed: '上傳失敗',
      biomeTitle: '群系顏色資料',
    },
  },
  ja: {
    translation: {
      title: 'Violet Map 管理',
      worlds: 'ワールド',
      upload: 'アップロード',
      biomes: 'バイオーム',
      refresh: '更新',
      world: 'ワールド',
      dimension: 'ディメンション',
      regions: 'リージョンファイル',
      noWorlds: 'ワールドがありません。データをアップロードしてください。',
      createWorld: '空のワールドを作成',
      worldName: 'ワールド名',
      levelName: 'レベル名',
      delete: '削除',
      uploadChunkData: 'チャンクデータをアップロード',
      uploadHelp: '.mca リージョンファイル、または xPos/zPos を含むチャンク NBT に対応します。',
      uploading: 'アップロード中...',
      save: '保存',
      saved: '保存しました。viewer を再読み込みすると反映されます。',
      token: '管理トークン',
      language: '言語',
      missingFile: '先にファイルを選択してください。',
      uploadFailed: 'アップロードに失敗しました',
      biomeTitle: 'バイオーム色データ',
    },
  },
} as const;

function initialLanguage(): string {
  const saved = localStorage.getItem('violet-map:language');
  if (saved && resources[saved as keyof typeof resources]) return saved;
  if (navigator.language.startsWith('ja')) return 'ja';
  if (navigator.language.startsWith('zh-TW') || navigator.language.startsWith('zh-HK')) return 'zh-TW';
  if (navigator.language.startsWith('zh')) return 'zh-CN';
  return 'en';
}

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export const languageOptions = [
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja', label: '日本語' },
];

export default i18n;
