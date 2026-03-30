{{/*
Expand the name of the chart.
*/}}
{{- define "agentops.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Full image reference for a component (server or web).
*/}}
{{- define "agentops.image" -}}
{{- $reg := .Values.global.imageRegistry -}}
{{- $repo := .Values.global.imageRepository -}}
{{- $suffix := .suffix -}}
{{- $tag := .Values.global.imageTag -}}
{{- printf "%s/%s%s:%s" $reg $repo $suffix $tag }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "agentops.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/*
Selector labels for a component.
*/}}
{{- define "agentops.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
