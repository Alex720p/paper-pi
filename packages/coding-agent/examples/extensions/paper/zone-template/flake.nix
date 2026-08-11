{
  description = "paper's execution zone: an ephemeral microvm.nix VM with no network";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    microvm = {
      url = "github:microvm-nix/microvm.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs, microvm, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      nixosConfigurations.zone = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [
          microvm.nixosModules.microvm
          ./zone.nix
        ];
      };

      # The extension talks to the guest over AF_VSOCK, which node has no support for, so it
      # shells out to socat. Exposing it here means the host needs nothing installed that this
      # flake does not already pin.
      packages.${system}.host-tools = pkgs.socat;

      # `zone_install` resolves an attribute name against this before it edits packages.json, so a
      # typo costs an eval rather than a full VM rebuild.
      legacyPackages.${system} = pkgs;
    };
}
