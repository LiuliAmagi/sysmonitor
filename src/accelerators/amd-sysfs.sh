# Collects AMD GPU metrics through the amdgpu driver's sysfs interface, so no ROCm tooling
# is required. One tab-separated line is printed per AMD DRM card (PCI vendor 0x1002),
# ordered by the numeric DRM card index:
#
#  0 drm card index            (from the card directory name)
#  1 drm card directory name   (card1)
#  2 PCI slot name             (0000:03:00.0)
#  3 gpu_busy_percent          (percent)
#  4 mem_info_vram_used        (bytes)
#  5 mem_info_vram_total       (bytes)
#  6 hwmon temp1_input         (millidegrees Celsius, edge)
#  7 hwmon temp2_input         (millidegrees Celsius, junction)
#  8 hwmon temp3_input         (millidegrees Celsius, memory)
#  9 hwmon power sensor         (microwatts on amdgpu, documented as milliwatts)
# 10 hwmon power limit sensor   (same unit as field 9)
# 11 product_name              (board name reported by the VBIOS)
# 12 PCI device id             (0x73bf)
#
# Readings the driver does not expose are printed as an empty field. Only cat and sed run per
# card, and the whole loop is one pipeline, so it stays cheap over SSH.

drm_root=${SYSMON_DRM_ROOT:-/sys/class/drm}

# Sensor node names change between kernel generations (power1_cap replaced power1_max), so the
# first node holding a number wins. Only numeric values are accepted, which also skips NA.
read_sensor() {
  sensor_directory=$1
  shift
  for node in "$@"; do
    [ -f "$sensor_directory/$node" ] || continue
    value=$(cat "$sensor_directory/$node" 2>/dev/null)
    case $value in
      '' | *[!0-9]*) continue ;;
    esac
    printf '%s' "$value"
    return
  done
}

for card in "$drm_root"/card[0-9]*; do
  device=$card/device
  [ -d "$device" ] || continue
  vendor=$(cat "$device/vendor" 2>/dev/null)
  [ "$vendor" = 0x1002 ] || continue

  card_name=${card##*/}
  slot=$(sed -n 's/^PCI_SLOT_NAME=//p' "$device/uevent" 2>/dev/null)

  # Older kernels keep the thermal and power sensors in a hwmon directory under the card device.
  hwmon=
  for sensor in "$device"/hwmon/hwmon*; do
    for node in "$sensor"/temp*_input; do
      [ -f "$node" ] && hwmon=$sensor
    done
  done

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${card_name#card}" "$card_name" "$slot" \
    "$(cat "$device/gpu_busy_percent" 2>/dev/null)" \
    "$(cat "$device/mem_info_vram_used" 2>/dev/null)" \
    "$(cat "$device/mem_info_vram_total" 2>/dev/null)" \
    "$(cat "$hwmon/temp1_input" 2>/dev/null)" \
    "$(cat "$hwmon/temp2_input" 2>/dev/null)" \
    "$(cat "$hwmon/temp3_input" 2>/dev/null)" \
    "$(read_sensor "$hwmon" power1_input power1_average)" \
    "$(read_sensor "$hwmon" power1_cap power1_max power1_rated_max power1_limit)" \
    "$(cat "$device/product_name" 2>/dev/null)" \
    "$(cat "$device/device" 2>/dev/null)"
done 2>/dev/null | sort -n
