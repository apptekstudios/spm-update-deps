import Foundation
import SPMUpdateCore

exit(await SPMUpdateCore.main(Array(CommandLine.arguments.dropFirst())))
