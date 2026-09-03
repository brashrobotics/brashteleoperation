#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
teleop_root="$(cd -- "${script_dir}/.." && pwd)"
controller_root="${BRASH_QUADRUPED_CONTROLLER_ROOT:-${teleop_root}/../brashquadrupedcontroller}"

if [[ ! -f "${teleop_root}/.env" ]]; then
  echo "Missing ${teleop_root}/.env. Copy .env.example to .env and replace every placeholder secret." >&2
  exit 1
fi
if [[ ! -f "${controller_root}/install/setup.bash" ]]; then
  echo "Missing ${controller_root}/install/setup.bash. Build the quadruped controller workspace first." >&2
  exit 1
fi
if [[ ! -f /opt/ros/jazzy/setup.bash ]]; then
  echo "ROS 2 Jazzy is not installed at /opt/ros/jazzy." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "${teleop_root}/.env"
set +a

docker compose \
  --env-file "${teleop_root}/.env" \
  -f "${teleop_root}/deployment/compose.simulation.yaml" \
  up --build --detach --wait

# shellcheck disable=SC1091
source /opt/ros/jazzy/setup.bash
# shellcheck disable=SC1090
source "${controller_root}/install/setup.bash"

# Also supports a dependency bundle extracted into this workspace when the ROS
# controller packages cannot be installed system-wide on a development host.
if [[ -d "${controller_root}/install/share/position_controllers" ]]; then
  export AMENT_PREFIX_PATH="${controller_root}/install${AMENT_PREFIX_PATH:+:${AMENT_PREFIX_PATH}}"
  export LD_LIBRARY_PATH="${controller_root}/install/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi

cd "${controller_root}"
exec ros2 launch brash_quadruped_bringup simulation.launch.py teleop_bridge:=true "$@"
