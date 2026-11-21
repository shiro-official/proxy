#!/bin/sh
set -eu

destination=/opt/ebunny-node24
version=v24.22.3

if [ "$(id -u)" -ne 0 ]; then
  echo 'Запусти этот скрипт через sudo.' >&2
  exit 1
fi

if [ -e "$destination" ]; then
  if [ -x "$destination/bin/node" ] && [ "$("$destination/bin/node" --version)" = "$version" ]; then
    "$destination/bin/node" --version
    exit 0
  fi
  echo "Каталог $destination уже занят. Проверь установленную копию Node.js." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)
    platform=linux-x64
    digest=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb
    ;;
  aarch64)
    platform=linux-arm64
    digest=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c
    ;;
  *)
    echo 'Для этой архитектуры установи Node.js 24 вручную.' >&2
    exit 1
    ;;
esac

work=$(mktemp -d /opt/.ebunny-node24.XXXXXX)
trap 'rm -rf -- "$work"' EXIT
archive=node-${version}-${platform}.tar.xz
curl --fail --silent --show-error --location --max-time 120 \
  "https://nodejs.org/dist/${version}/${archive}" --output "$work/$archive"
printf '%s  %s\n' "$digest" "$work/$archive" | sha256sum --check
mkdir "$work/node"
tar -xJf "$work/$archive" -C "$work/node" --strip-components=1 --no-same-owner
test "$("$work/node/bin/node" --version)" = "$version"
mv -T -- "$work/node" "$destination"
"$destination/bin/node" --version
