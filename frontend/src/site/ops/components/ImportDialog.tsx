import { useState } from 'react'
import { Modal } from '../../../ui/Modal'
import { Button } from '../../../ui/Button'
import { FormField } from '../../../ui/Form'

type ParsedAsset = {
  component_key: string
  name: string
  env: string
  region: string
  role_arn: string
  enabled: boolean
}

export function ImportDialog(props: { open: boolean; onClose: () => void; onImport: (assets: ParsedAsset[]) => Promise<void> }) {
  const { open, onClose, onImport } = props
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ParsedAsset[]>([])
  const [parseError, setParseError] = useState('')
  const [importing, setImporting] = useState(false)

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setParseError('')
    setParsed([])

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const text = String(reader.result || '')
        if (f.name.endsWith('.json')) {
          const j = JSON.parse(text)
          if (!Array.isArray(j)) throw new Error('JSON 必须是数组格式')
          setParsed(j)
        } else if (f.name.endsWith('.csv')) {
          const lines = text.split('\n').filter((l) => l.trim())
          if (lines.length < 2) throw new Error('CSV 至少需要 2 行（表头 + 数据）')
          const [header, ...rows] = lines
          const headers = header.split(',').map((h) => h.trim())
          const result: ParsedAsset[] = []
          for (const row of rows) {
            const values = row.split(',').map((v) => v.trim())
            const obj: any = {}
            headers.forEach((h, idx) => {
              obj[h] = values[idx] || ''
            })
            result.push({
              component_key: obj.component_key || 'flink',
              name: obj.name || '',
              env: obj.env || '',
              region: obj.region || '',
              role_arn: obj.role_arn || '',
              enabled: obj.enabled === 'true',
            })
          }
          setParsed(result)
        } else {
          throw new Error('仅支持 .csv 和 .json 文件')
        }
      } catch (e: any) {
        setParseError(String(e?.message || e))
      }
    }
    reader.readAsText(f)
  }

  async function handleImport() {
    if (parsed.length === 0) return
    setImporting(true)
    try {
      await onImport(parsed)
      onClose()
    } catch {
      // Error handled by parent
    } finally {
      setImporting(false)
    }
  }

  function downloadTemplate() {
    const csv = ['component_key,name,env,region,role_arn,enabled', 'flink,示例Flink,prod,us-west-1,acs:ram::xxx:role/MyRole,true'].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'asset_import_template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Modal open={open} title="批量导入资产" onClose={onClose}>
      <div style={{ padding: 14, display: 'grid', gap: 14 }}>
        <FormField label="选择文件" help="支持 CSV 或 JSON 格式">
          <input type="file" accept=".csv,.json" onChange={handleFileChange} />
        </FormField>

        {parseError ? <div style={{ color: 'rgba(255,120,120,0.95)', fontSize: 12 }}>{parseError}</div> : null}

        {parsed.length > 0 ? (
          <div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>已解析 {parsed.length} 条资产</div>
            <div style={{ maxHeight: 240, overflow: 'auto', fontSize: 11, opacity: 0.75, lineHeight: 1.6 }}>
              {parsed.slice(0, 10).map((a, idx) => (
                <div key={idx}>
                  {idx + 1}. {a.name} ({a.component_key})
                </div>
              ))}
              {parsed.length > 10 ? <div>...还有 {parsed.length - 10} 项</div> : null}
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', marginTop: 8 }}>
          <Button variant="ghost" onClick={downloadTemplate}>
            下载模板
          </Button>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button variant="ghost" onClick={onClose} disabled={importing}>
              取消
            </Button>
            <Button variant="primary" onClick={handleImport} disabled={parsed.length === 0 || importing}>
              {importing ? '导入中…' : `导入 ${parsed.length} 项`}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
