#!/bin/bash

# Qwen-Code Core - Production Deployment Script
# Version: 1.0.0-alpha.1
# License: MIT
# Author: Qwen-Code Creative Team

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DEPLOYMENT_ENV="${DEPLOYMENT_ENV:-production}"
DOCKER_REGISTRY="${DOCKER_REGISTRY:-ghcr.io/qwen-code}"
IMAGE_TAG="${IMAGE_TAG:-1.0.0-alpha.1}"
NAMESPACE="${NAMESPACE:-qwen-code}"
HELM_CHART_PATH="${HELM_CHART_PATH:-$PROJECT_ROOT/helm}"

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Validation functions
validate_environment() {
    log_info "Validating deployment environment..."
    
    # Check required tools
    local required_tools=("docker" "kubectl" "helm" "git")
    for tool in "${required_tools[@]}"; do
        if ! command -v "$tool" &> /dev/null; then
            log_error "$tool is required but not installed"
            exit 1
        fi
    done
    
    # Check Kubernetes context
    if ! kubectl cluster-info &> /dev/null; then
        log_error "Cannot connect to Kubernetes cluster"
        exit 1
    fi
    
    # Check Docker daemon
    if ! docker info &> /dev/null; then
        log_error "Cannot connect to Docker daemon"
        exit 1
    fi
    
    log_success "Environment validation passed"
}

validate_configuration() {
    log_info "Validating configuration files..."
    
    local required_files=(
        "$PROJECT_ROOT/.env.$DEPLOYMENT_ENV"
        "$PROJECT_ROOT/docker-compose.yml"
        "$PROJECT_ROOT/Dockerfile"
    )
    
    for file in "${required_files[@]}"; do
        if [[ ! -f "$file" ]]; then
            log_error "Required file not found: $file"
            exit 1
        fi
    done
    
    log_success "Configuration validation passed"
}

# Build functions
build_docker_image() {
    log_info "Building Docker image..."
    
    local image_name="$DOCKER_REGISTRY/qwen-code-core:$IMAGE_TAG"
    
    cd "$PROJECT_ROOT"
    
    # Build with BuildKit for better performance
    export DOCKER_BUILDKIT=1
    
    docker build \
        --target production \
        --tag "$image_name" \
        --tag "$DOCKER_REGISTRY/qwen-code-core:latest" \
        --build-arg BUILDKIT_INLINE_CACHE=1 \
        --cache-from "$DOCKER_REGISTRY/qwen-code-core:latest" \
        .
    
    if [[ $? -eq 0 ]]; then
        log_success "Docker image built successfully: $image_name"
    else
        log_error "Failed to build Docker image"
        exit 1
    fi
}

push_docker_image() {
    log_info "Pushing Docker image to registry..."
    
    local image_name="$DOCKER_REGISTRY/qwen-code-core:$IMAGE_TAG"
    
    # Login to registry if needed
    if [[ "$DOCKER_REGISTRY" != "localhost" ]]; then
        log_info "Logging into Docker registry..."
        echo "$DOCKER_REGISTRY_PASSWORD" | docker login "$DOCKER_REGISTRY" -u "$DOCKER_REGISTRY_USERNAME" --password-stdin
    fi
    
    # Push image
    docker push "$image_name"
    docker push "$DOCKER_REGISTRY/qwen-code-core:latest"
    
    log_success "Docker image pushed successfully"
}

# Deployment functions
deploy_kubernetes() {
    log_info "Deploying to Kubernetes..."
    
    # Create namespace if it doesn't exist
    kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
    
    # Apply secrets and configmaps
    kubectl apply -f "$PROJECT_ROOT/k8s/secrets.yaml" -n "$NAMESPACE"
    kubectl apply -f "$PROJECT_ROOT/k8s/configmaps.yaml" -n "$NAMESPACE"
    
    # Deploy with Helm
    if [[ -d "$HELM_CHART_PATH" ]]; then
        helm upgrade --install qwen-code-core "$HELM_CHART_PATH" \
            --namespace "$NAMESPACE" \
            --set image.tag="$IMAGE_TAG" \
            --set image.repository="$DOCKER_REGISTRY/qwen-code-core" \
            --set environment="$DEPLOYMENT_ENV" \
            --wait \
            --timeout 10m
    else
        # Fallback to direct kubectl apply
        kubectl apply -f "$PROJECT_ROOT/k8s/deployment.yaml" -n "$NAMESPACE"
        kubectl apply -f "$PROJECT_ROOT/k8s/service.yaml" -n "$NAMESPACE"
        kubectl apply -f "$PROJECT_ROOT/k8s/ingress.yaml" -n "$NAMESPACE"
    fi
    
    log_success "Kubernetes deployment completed"
}

deploy_docker_compose() {
    log_info "Deploying with Docker Compose..."
    
    cd "$PROJECT_ROOT"
    
    # Load environment variables
    if [[ -f ".env.$DEPLOYMENT_ENV" ]]; then
        export $(cat ".env.$DEPLOYMENT_ENV" | xargs)
    fi
    
    # Deploy services
    docker-compose -f docker-compose.yml up -d --remove-orphans
    
    log_success "Docker Compose deployment completed"
}

# Health check functions
wait_for_deployment() {
    log_info "Waiting for deployment to be ready..."
    
    local max_attempts=30
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        if kubectl get pods -n "$NAMESPACE" -l app=qwen-code-core --no-headers | grep -q "Running"; then
            log_success "Deployment is ready"
            return 0
        fi
        
        log_info "Attempt $attempt/$max_attempts: Waiting for pods to be ready..."
        sleep 10
        ((attempt++))
    done
    
    log_error "Deployment failed to become ready within timeout"
    return 1
}

check_health() {
    log_info "Performing health checks..."
    
    # Check Kubernetes deployment
    if kubectl get deployment qwen-code-core -n "$NAMESPACE" &> /dev/null; then
        local replicas=$(kubectl get deployment qwen-code-core -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}')
        local desired=$(kubectl get deployment qwen-code-core -n "$NAMESPACE" -o jsonpath='{.spec.replicas}')
        
        if [[ "$replicas" == "$desired" ]]; then
            log_success "Kubernetes deployment healthy: $replicas/$desired replicas ready"
        else
            log_warning "Kubernetes deployment partially healthy: $replicas/$desired replicas ready"
        fi
    fi
    
    # Check Docker Compose services
    if [[ -f "$PROJECT_ROOT/docker-compose.yml" ]]; then
        cd "$PROJECT_ROOT"
        if docker-compose ps | grep -q "Up"; then
            log_success "Docker Compose services healthy"
        else
            log_warning "Some Docker Compose services may not be healthy"
        fi
    fi
}

# Rollback functions
rollback_deployment() {
    log_warning "Rolling back deployment..."
    
    if [[ -d "$HELM_CHART_PATH" ]]; then
        helm rollback qwen-code-core -n "$NAMESPACE"
    else
        # Manual rollback
        kubectl rollout undo deployment/qwen-code-core -n "$NAMESPACE"
    fi
    
    log_success "Rollback completed"
}

# Cleanup functions
cleanup() {
    log_info "Performing cleanup..."
    
    # Remove old Docker images
    docker image prune -f
    
    # Remove old Kubernetes resources
    kubectl delete pods -n "$NAMESPACE" --field-selector=status.phase=Succeeded --dry-run=client -o yaml | kubectl apply -f -
    
    log_success "Cleanup completed"
}

# Main deployment function
main() {
    local start_time=$(date +%s)
    
    log_info "Starting Qwen-Code Core deployment..."
    log_info "Environment: $DEPLOYMENT_ENV"
    log_info "Image Tag: $IMAGE_TAG"
    log_info "Namespace: $NAMESPACE"
    
    # Validate environment and configuration
    validate_environment
    validate_configuration
    
    # Build and push Docker image
    build_docker_image
    push_docker_image
    
    # Deploy based on environment
    case "$DEPLOYMENT_ENV" in
        "kubernetes"|"k8s")
            deploy_kubernetes
            wait_for_deployment
            ;;
        "docker-compose"|"compose")
            deploy_docker_compose
            ;;
        "production"|"staging")
            deploy_kubernetes
            wait_for_deployment
            ;;
        *)
            log_error "Unknown deployment environment: $DEPLOYMENT_ENV"
            exit 1
            ;;
    esac
    
    # Health checks
    check_health
    
    # Cleanup
    cleanup
    
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    log_success "Deployment completed successfully in ${duration} seconds"
}

# Signal handling
trap 'log_error "Deployment interrupted"; exit 1' INT TERM

# Help function
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -e, --environment ENV    Deployment environment (production, staging, kubernetes, docker-compose)"
    echo "  -t, --tag TAG            Docker image tag"
    echo "  -n, --namespace NS       Kubernetes namespace"
    echo "  -r, --registry REG       Docker registry"
    echo "  -h, --help               Show this help message"
    echo ""
    echo "Environment Variables:"
    echo "  DEPLOYMENT_ENV           Deployment environment"
    echo "  IMAGE_TAG                Docker image tag"
    echo "  NAMESPACE                Kubernetes namespace"
    echo "  DOCKER_REGISTRY          Docker registry"
    echo "  DOCKER_REGISTRY_USERNAME Docker registry username"
    echo "  DOCKER_REGISTRY_PASSWORD Docker registry password"
    echo ""
    echo "Examples:"
    echo "  $0 --environment production --tag 1.0.0-alpha.1"
    echo "  $0 --environment kubernetes --namespace qwen-code"
    echo "  DEPLOYMENT_ENV=docker-compose $0"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -e|--environment)
            DEPLOYMENT_ENV="$2"
            shift 2
            ;;
        -t|--tag)
            IMAGE_TAG="$2"
            shift 2
            ;;
        -n|--namespace)
            NAMESPACE="$2"
            shift 2
            ;;
        -r|--registry)
            DOCKER_REGISTRY="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Run main function
main "$@"