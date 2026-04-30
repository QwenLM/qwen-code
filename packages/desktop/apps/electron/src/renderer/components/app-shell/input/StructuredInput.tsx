import type { PermissionRequest as PermissionRequestType, CredentialRequest as CredentialRequestType } from '../../../../shared/types'
import { PermissionRequest } from './structured/PermissionRequest'
import { CredentialRequest } from './structured/CredentialRequest'
import { AdminApprovalRequest } from './structured/AdminApprovalRequest'
import type { StructuredInputState, StructuredResponse } from './structured/types'

interface StructuredInputProps {
  state: StructuredInputState
  onResponse: (response: StructuredResponse) => void
  /** When true, removes container styling (shadow, bg, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean
}

/**
 * StructuredInput - Router component for structured input UIs
 *
 * Routes to the appropriate component based on the input type:
 * - permission: PermissionRequest (bash command approval)
 * - credential: CredentialRequest (secure auth input)
 */
export function StructuredInput({ state, onResponse, unstyled = false }: StructuredInputProps) {
  switch (state.type) {
    case 'permission':
      return (
        <PermissionRequest
          request={state.data as PermissionRequestType}
          onResponse={onResponse}
          unstyled={unstyled}
        />
      )
    case 'credential':
      return (
        <CredentialRequest
          request={state.data as CredentialRequestType}
          onResponse={onResponse}
          unstyled={unstyled}
        />
      )
    case 'admin_approval':
      return (
        <AdminApprovalRequest
          request={state.data as import('./structured/AdminApprovalRequest').AdminApprovalRequestData}
          onApprove={({ rememberForMinutes }) => onResponse({ type: 'admin_approval', approved: true, rememberForMinutes })}
          onCancel={() => onResponse({ type: 'admin_approval', approved: false })}
          unstyled={unstyled}
        />
      )
    default:
      return null
  }
}
