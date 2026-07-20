import { Drawer } from '../../../ui/Drawer'
import { AssetForm } from './AssetForm'

type AssetFormData = {
  id?: string
  component_key: string
  name: string
  env: string
  region: string
  role_arn: string
  config: string
  enabled: boolean
}

export function AssetDrawer(props: {
  open: boolean
  initialData?: Partial<AssetFormData>
  onClose: () => void
  onSubmit: (data: AssetFormData) => Promise<void>
  submitting?: boolean
}) {
  const { open, initialData, onClose, onSubmit, submitting } = props

  return (
    <Drawer open={open} title={initialData?.id ? '编辑资产' : '创建资产'} onClose={onClose} width={600}>
      <AssetForm initialData={initialData} onSubmit={onSubmit} onCancel={onClose} submitting={submitting} />
    </Drawer>
  )
}
