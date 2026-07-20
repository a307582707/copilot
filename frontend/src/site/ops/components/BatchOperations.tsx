import { Button } from '../../../ui/Button'

export function BatchOperations(props: { selectedCount: number; onEnableDisable: () => void; onDelete: () => void; onExport: () => void; onClearSelection: () => void }) {
  const { selectedCount, onEnableDisable, onDelete, onExport, onClearSelection } = props

  if (selectedCount === 0) return null

  return (
    <div
      style={{
        position: 'sticky',
        bottom: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 50,
        display: 'inline-flex',
        gap: 10,
        padding: '10px 14px',
        borderRadius: 14,
        border: '1px solid #e2e8f0',
        background: '#ffffff',
        backdropFilter: 'none',
        boxShadow: '0 18px 36px rgba(15, 23, 42, 0.10)',
        alignItems: 'center',
        maxWidth: 'min(720px, calc(100vw - 48px))',
      }}
    >
      <div style={{ fontSize: 12, color: '#334155', fontWeight: 850 }}>已选择 {selectedCount} 项</div>
      <div style={{ width: 1, height: 20, background: '#e2e8f0' }} />
      <Button variant="ghost" size="sm" onClick={onEnableDisable}>
        批量启用/禁用
      </Button>
      <Button variant="danger" size="sm" onClick={onDelete}>
        批量删除
      </Button>
      <Button variant="ghost" size="sm" onClick={onExport}>
        导出
      </Button>
      <Button variant="ghost" size="sm" onClick={onClearSelection}>
        取消选择
      </Button>
    </div>
  )
}
