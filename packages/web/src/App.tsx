import { useEffect, useState } from 'react';
import { Badge, Box, Button, Card, Flex, Select, Slider, Text, TextField, Theme } from '@radix-ui/themes';
import { fetchWorlds } from './api';
import { Viewer, type CameraPositionRequest } from './render/Viewer';

interface WorldInfo { id: string; dimensions: string[] }
type Axis = 'x' | 'y' | 'z';

function coordText(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const rounded = Math.round(v * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export default function App() {
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [world, setWorld] = useState('');
  const [dimension, setDimension] = useState('minecraft:overworld');
  const [viewDistance, setViewDistance] = useState(8);
  const [lodDistance, setLodDistance] = useState(8);
  const [timeOfDay, setTimeOfDay] = useState(0);
  const [stats, setStats] = useState({ loaded: 0, rendered: 0, pos: [0, 0, 0] as [number, number, number] });
  const [coordDirty, setCoordDirty] = useState(false);
  const [coordDraft, setCoordDraft] = useState<Record<Axis, string>>({ x: '8', y: '120', z: '8' });
  const [cameraTarget, setCameraTarget] = useState<CameraPositionRequest>();

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
  const draftValues = [Number(coordDraft.x), Number(coordDraft.y), Number(coordDraft.z)] as const;
  const draftValid = draftValues.every(Number.isFinite);
  const handleStats = (next: typeof stats) => {
    setStats(next);
    if (!coordDirty) {
      const draft = { x: coordText(next.pos[0]), y: coordText(next.pos[1]), z: coordText(next.pos[2]) };
      setCoordDraft((prev) => (
        prev.x === draft.x && prev.y === draft.y && prev.z === draft.z ? prev : draft
      ));
    }
  };
  const setAxis = (axis: Axis, value: string) => {
    setCoordDirty(true);
    setCoordDraft((prev) => ({ ...prev, [axis]: value }));
  };
  const useCurrentPosition = () => {
    setCoordDraft({ x: coordText(stats.pos[0]), y: coordText(stats.pos[1]), z: coordText(stats.pos[2]) });
    setCoordDirty(false);
  };
  const applyPosition = () => {
    if (!draftValid) return;
    setCoordDirty(false);
    setCameraTarget({ x: draftValues[0], y: draftValues[1], z: draftValues[2], seq: Date.now() });
  };

  return (
    <Theme appearance="dark" accentColor="grass" style={{ height: '100%' }}>
      <Box style={{ position: 'relative', height: '100%' }}>
        {world && (
          <Viewer
            world={world} dimension={dimension}
            viewDistance={viewDistance} lodDistance={lodDistance}
            timeOfDay={timeOfDay} cameraTarget={cameraTarget} onStats={handleStats}
          />
        )}
        {/* 准星 */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%', width: 12, height: 12,
          transform: 'translate(-50%,-50%)', pointerEvents: 'none',
          background: 'radial-gradient(circle, rgba(255,255,255,.8) 0 1.5px, transparent 2px)',
        }} />
        <Card style={{ position: 'absolute', top: 12, left: 12, width: 320, opacity: 0.92 }}>
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
            <Flex gap="2" align="end">
              {(['x', 'y', 'z'] as Axis[]).map((axis) => (
                <Box key={axis} style={{ flex: 1, minWidth: 0 }}>
                  <Text as="label" size="1" htmlFor={`coord-${axis}`} style={{ display: 'block', marginBottom: 4 }}>
                    {axis.toUpperCase()}
                  </Text>
                  <TextField.Root
                    id={`coord-${axis}`}
                    size="1"
                    type="number"
                    value={coordDraft[axis]}
                    onChange={(e) => setAxis(axis, e.currentTarget.value)}
                  />
                </Box>
              ))}
              <Button size="1" variant="soft" onClick={useCurrentPosition}>当前</Button>
              <Button size="1" disabled={!draftValid} onClick={applyPosition}>前往</Button>
            </Flex>
            <Text size="1" color="gray">点击画面锁定鼠标 · WASD 移动 · 空格/Shift 升降 · Ctrl 加速</Text>
          </Flex>
        </Card>
      </Box>
    </Theme>
  );
}
