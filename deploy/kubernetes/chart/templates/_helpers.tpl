{{- define "managed-agent.labels" -}}
app.kubernetes.io/name: qwen-managed-agent
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "managed-agent.secret" -}}
{{- default (printf "%s-keys" .Release.Name) .Values.credentials.existingSecret -}}
{{- end -}}
