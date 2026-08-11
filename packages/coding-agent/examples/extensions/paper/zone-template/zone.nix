# The execution zone: one NixOS micro-VM per pi session.
#
# Everything here is ephemeral. The workspace arrives as a read-only share and is covered by a
# tmpfs overlay, so the guest can write anywhere it likes and none of it reaches the host. There
# is no network interface at all.
#
# You own this file. `zone_install` never touches it — it only appends names to packages.json,
# which is read below.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  # Written by the extension into a per-session copy of this flake. The defaults keep the flake
  # evaluable on its own (`nix flake check`, `nix build .#nixosConfigurations.zone...`).
  session =
    if builtins.pathExists ./session.nix then
      import ./session.nix
    else
      {
        cid = 3;
        lowerSource = "/var/empty";
        vcpu = 4;
        memMb = 4096;
        upperSizeMb = 2048;
        shareProto = "virtiofs";
        workspaceMode = "overlay";
        machine = "q35";
      };

  packageNames = builtins.fromJSON (builtins.readFile ./packages.json);

  unknown = builtins.filter (name: !(builtins.hasAttr name pkgs)) packageNames;

  packages =
    if unknown == [ ] then
      map (name: pkgs.${name}) packageNames
    else
      throw "packages.json names attributes that do not exist in nixpkgs: ${lib.concatStringsSep ", " unknown}";

  shell = lib.getExe pkgs.bashInteractive;

  # Mounting the workspace is a script rather than a `fileSystems` entry because the overlay's
  # upperdir and workdir have to be created after the tmpfs is mounted and before the overlay is,
  # and because the agent re-runs it mid-session whenever the read-only lower layer changes.
  workspaceCtl = pkgs.writeShellScriptBin "paper-workspace-ctl" ''
    set -eu
    export PATH=${
      lib.makeBinPath [
        pkgs.coreutils
        pkgs.util-linux
      ]
    }

    lower=/mnt/lower
    upper=/mnt/upper/up
    target=/workspace

    mount_workspace() {
      mkdir -p "$upper" "$target"
    ${
      if session.workspaceMode or "overlay" == "copy" then
        ''
          cp -a "$lower"/. "$target"/ 2>/dev/null || true
        ''
      else
        ''
          # A fresh workdir each time: overlayfs refuses one still claimed by a lazily
          # unmounted predecessor.
          work=$(mktemp -d /mnt/upper/work.XXXXXX)
          mount -t overlay overlay \
            -o lowerdir="$lower",upperdir="$upper",workdir="$work",index=off,metacopy=off,xino=off \
            "$target"
        ''
    }
    }

    case "''${1:-mount}" in
      mount)
        mount_workspace
        ;;
      remount)
    ${
      if session.workspaceMode or "overlay" == "copy" then
        ''
          # In copy mode the workspace and the ephemeral changes are the same tree, so there is
          # no way to pick up the lower layer without discarding the agent's work. Do nothing.
          :
        ''
      else
        ''
          # Re-read a lower layer the write zone changed under us. The upper layer, and so
          # everything the agent has done in here, is carried across untouched.
          umount "$target" 2>/dev/null || umount -l "$target" 2>/dev/null || true
          mount_workspace
        ''
    }
        ;;
      *)
        echo "usage: paper-workspace-ctl [mount|remount]" >&2
        exit 2
        ;;
    esac
  '';

  agent = pkgs.writers.writePython3Bin "paper-zone-agent" { flakeIgnore = [ "E501" ]; } (
    builtins.readFile ./agent.py
  );
in
{
  # --- the VM ----------------------------------------------------------------

  microvm = {
    hypervisor = "qemu";
    vcpu = session.vcpu or 4;
    mem = session.memMb or 4096;

    # No interfaces, no forwardPorts, no network device of any kind. This is the invariant the
    # whole extension rests on: the zone that can run arbitrary commands cannot reach anything.
    interfaces = [ ];

    # The only channel in or out. systemd socket-activates the agent on it; see below.
    vsock.cid = session.cid or 3;

    shares = [
      {
        tag = "lower";
        source = session.lowerSource or "/var/empty";
        mountPoint = "/mnt/lower";
        proto = session.shareProto or "virtiofs";
        # Enforced on the host, not by a guest mount option the guest's root could undo: for 9p
        # it becomes `-fsdev local,...,readonly=on` in the qemu command line, and for virtiofs it
        # becomes `--readonly` on virtiofsd. Check with:
        #   grep -r readonly $(nix build --no-link --print-out-paths \
        #     path:.#nixosConfigurations.zone.config.microvm.declaredRunner)/bin
        readOnly = true;
        # The write zone mutates this directory while we are running. Caching its metadata would
        # hand the agent a file it had just replaced.
        cache = "never";
      }
    ];

    # microvm.nix defaults to qemu's "microvm" machine, which is leaner and boots faster but
    # hangs in early kernel init on some hosts — nested virtualisation in particular. "q35" is
    # the ordinary PC machine and boots everywhere; change it with zone.machine in paper.json.
    qemu.machine = session.machine or "q35";
    qemu.serialConsole = true;
  };

  # --- the workspace ---------------------------------------------------------

  fileSystems."/mnt/upper" = {
    fsType = "tmpfs";
    options = [
      "size=${toString (session.upperSizeMb or 2048)}m"
      "mode=0755"
    ];
  };

  systemd.services.paper-workspace = {
    description = "Mount the ephemeral workspace over the read-only share";
    wantedBy = [ "multi-user.target" ];
    requires = [
      "mnt-lower.mount"
      "mnt-upper.mount"
    ];
    after = [
      "mnt-lower.mount"
      "mnt-upper.mount"
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${workspaceCtl}/bin/paper-workspace-ctl mount";
    };
  };

  # --- the control channel ---------------------------------------------------

  # Accept=yes gives every connection its own service instance with the socket as stdin/stdout,
  # so the agent is a plain filter and concurrent bash calls need no multiplexing.
  #
  # The socket deliberately does not wait for the workspace: sockets.target is ordered before
  # multi-user.target, so requiring a multi-user service here is an ordering cycle and systemd
  # resolves it by dropping the socket entirely. The dependency belongs on the instance below,
  # which is what actually needs the mount, and which socket activation starts on demand.
  systemd.sockets.paper-zone = {
    description = "paper execution zone control channel";
    wantedBy = [ "sockets.target" ];
    socketConfig = {
      ListenStream = "vsock::1024";
      Accept = true;
    };
  };

  systemd.services."paper-zone@" = {
    description = "paper execution zone command %i";
    requires = [ "paper-workspace.service" ];
    after = [ "paper-workspace.service" ];
    serviceConfig = {
      ExecStart = "${agent}/bin/paper-zone-agent";
      StandardInput = "socket";
      StandardOutput = "socket";
      StandardError = "journal";
      # Otherwise systemd tears down the connection's whole cgroup when the agent exits, and a
      # server the agent started in the background dies with the command that started it. The
      # agent still kills the process group itself on a timeout or a cancellation; this only
      # changes what happens after a command exits cleanly, and the VM is the real boundary.
      KillMode = "process";
      Environment = [
        "PAPER_ZONE_SHELL=${shell}"
        "PAPER_ZONE_CTL=${workspaceCtl}/bin/paper-workspace-ctl"
        "PAPER_ZONE_PATH=/run/current-system/sw/bin:/run/current-system/sw/sbin"
      ];
    };
  };

  # --- the guest ------------------------------------------------------------

  environment.systemPackages = packages ++ [ workspaceCtl ];

  users.users.root.password = "";
  services.getty.autologinUser = lib.mkForce null;

  networking.hostName = "paper-zone";
  networking.useDHCP = false;
  networking.firewall.enable = false;

  # Nothing here outlives the session, so there is nothing to keep compatible.
  system.stateVersion = config.system.nixos.release;
}
