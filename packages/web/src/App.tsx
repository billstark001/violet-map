import { useEffect, useState } from 'react';
import { Badge, Box, Card, Flex, Select, Slider, Text, Theme } from '@radix-ui/themes';
import { fetchWorlds } from './api';
import { Viewer } from './render/Viewer';

interface WorldInfo { id: string; dimensions: string[] }

export default function App() {
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [world, setWorld] = useState('');
  const [dimension, setDimension] = useState('minecraft:overworld');
  const [viewDistance, setViewDistance] = useState(8);
  const [lodDistance, setLodDistance] = useState(8);
  const [timeOfDay, setTimeOfDay] = useState(0);
  const [stats, setStats] = useState({ loaded: 0, rendered: 0, pos: [0, 0, 0] as [number, number, number] });

  useEffect(() => {
    fetchWorlds().then((ws) => {
      setWorlds(ws);
      if (ws.length) {
        setWorld(ws[0].id);
        setDimension(ws[0].dimensions[0] ?? 'minecraft:overworld');
      }
    }).catch(console.error);
  }, []);

  const dims = worlds.find((w) => w.id === world)?.dimensions ?? [];

  return (
    <Theme appearance="dark" accentColor="grass" style={{ height: '100%' }}>
      <Box style={{ position: 'relative', height: '100%' }}>
        {world && (
          <Viewer
            world={world} dimension={dimension}
            viewDistance={viewDistance} lodDistance={lodDistance}
            timeOfDay={timeOfDay} onStats={setStats}
          />
        )}
        {/* 准星 */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%', width: 12, height: 12,
          transform: 'translate(-50%,-50%)', pointerEvents: 'none',
          background: 'radial-gradient(circle, rgba(255,255,255,.8) 0 1.5px, transparent 2px)',
        }} />
        <Card style={{ position: 'absolute', top: 12, left: 12, width: 280, opacity: 0.92 }}>
          <Flex direction="column" gap="3">
            <Flex gap="2" align="center">
              <Text size="1" style={{ width: 48 }}>世界</Text>
              <Select.Root value={world} onValueChange={setWorld}>
                <Select.Trigger style={{ flex: 1 }} placeholder="选择世界" />
                <Select.Content>
                  {worlds.map((w) => <Select.Item key={w.id} value={w.id}>{w.id}</Select.Item>)}
                </Select.Content>
              </Select.Root>
            </Flex>
            <Flex gap="2" align="center">
              <Text size="1" style={{ width: 48 }}>维度</Text>
              <Select.Root value={dimension} onValueChange={setDimension}>
                <Select.Trigger style={{ flex: 1 }} />
                <Select.Content>
                  {dims.map((d) => <Select.Item key={d} value={d}>{d.replace('minecraft:', '')}</Select.Item>)}
                </Select.Content>
              </Select.Root>
            </Flex>
            <Box>
              <Text size="1">渲染距离：{viewDistance} 区块（LOD +{lodDistance}）</Text>
              <Slider value={[viewDistance]} min={2} max={16} onValueChange={([v]) => setViewDistance(v)} />
              <Slider mt="2" value={[lodDistance]} min={0} max={24} onValueChange={([v]) => setLodDistance(v)} />
            </Box>
            <Box>
              <Text size="1">时间（0=正午 0.5=午夜）：{timeOfDay.toFixed(2)}</Text>
              <Slider value={[timeOfDay]} min={0} max={1} step={0.01} onValueChange={([v]) => setTimeOfDay(v)} />
            </Box>
            <Flex gap="2" wrap="wrap">
              <Badge>XYZ {stats.pos.map((v) => v.toFixed(0)).join(' / ')}</Badge>
              <Badge color="blue">已加载 {stats.loaded}</Badge>
              <Badge color="green">已渲染 {stats.rendered}</Badge>
            </Flex>
            <Text size="1" color="gray">点击画面锁定鼠标 · WASD 移动 · 空格/Shift 升降 · Ctrl 加速</Text>
          </Flex>
        </Card>
      </Box>
    </Theme>
  );
}