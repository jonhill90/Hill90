package cmd

import (
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "akm",
	Short: "Agent Knowledge Manager CLI",
	Long:  "CLI for agents to persist and retrieve knowledge across sessions.",
}

func Execute() error {
	return rootCmd.Execute()
}

func init() {
	rootCmd.AddCommand(writeCmd)
	rootCmd.AddCommand(readCmd)
	rootCmd.AddCommand(listCmd)
	rootCmd.AddCommand(searchCmd)
	rootCmd.AddCommand(journalCmd)
	rootCmd.AddCommand(contextCmd)
}
